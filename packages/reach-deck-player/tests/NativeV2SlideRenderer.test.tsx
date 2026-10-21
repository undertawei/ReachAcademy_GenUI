import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReachDeckNativeSlideV2 } from '@reachany/reach-deck-dsl';
import type {
  ReachDeckCategoricalChartElementV2,
  ReachDeckNativeSlideV2,
  ReachDeckScientificVisualElementV2,
  ReachDeckTextFrameV2,
} from '@reachany/reach-deck-dsl';

import { NativeV2SlideRenderer } from '../src/NativeV2SlideRenderer.js';

const color = { kind: 'srgb' as const, value: '#123456' };
const transform = { x: 10, y: 20, width: 200, height: 100 };

const scientificElement = (): ReachDeckScientificVisualElementV2 => ({
  id: 'scientific',
  type: 'scientificVisual',
  transform,
  zIndex: 1,
  ariaLabel: 'Scientific visual',
  documentHtml: '<main></main><script>ReachScientificVisual.register({present(){}})</script>',
  manifest: {
    schemaVersion: 'reach-scientific-visual-manifest/v2',
    hooksVersion: 'reach-scientific-visual-hooks/v1',
    anchors: [],
    dependencies: [],
    resourceIds: [],
    ariaLabel: 'Scientific visual',
    textAlternative: 'A deterministic scientific visual.',
  },
});

const textFrame = (id: string, list = false): ReachDeckTextFrameV2 => {
  const paragraph = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: 'Native text',
        marks: [
          { type: 'bold' },
          { type: 'italic' },
          {
            type: 'textStyle',
            attrs: { fontFamily: 'Noto Sans', fontSize: '20px', color: '#123456' },
          },
        ],
      },
    ],
  };
  return {
    margins: { left: 8, top: 4, right: 8, bottom: 4 },
    verticalAlignment: 'middle',
    wrap: true,
    autofit: { mode: 'none' },
    doc: {
      type: 'doc',
      content: [
        list
          ? { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] }
          : paragraph,
      ],
    },
    fontSubstitutions: [],
  };
};

const supportedSlide = (): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'native-slide',
  title: 'Native slide',
  background: {
    kind: 'gradient',
    angle: 90,
    stops: [
      { offset: 0, color: { kind: 'srgb', value: '#ffffff' } },
      { offset: 1, color: { kind: 'srgb', value: '#eeeeee' } },
    ],
  },
  elements: [
    {
      id: 'rectangle',
      type: 'shape',
      transform,
      zIndex: 1,
      geometry: { kind: 'preset', preset: 'rectangle' },
      style: {
        fill: { kind: 'solid', color },
        stroke: { width: 2, fill: { kind: 'srgb', value: '#000000' } },
      },
    },
    {
      id: 'ellipse',
      type: 'shape',
      transform: { ...transform, x: 220 },
      zIndex: 2,
      geometry: { kind: 'preset', preset: 'ellipse' },
      style: {
        fill: {
          kind: 'gradient',
          angle: 0,
          stops: [
            { offset: 0, color: { kind: 'srgb', value: '#ff0000' } },
            { offset: 1, color: { kind: 'srgb', value: '#0000ff' } },
          ],
        },
      },
    },
    {
      id: 'line',
      type: 'line',
      transform: { x: 10, y: 140, width: 200, height: 20 },
      zIndex: 3,
      start: { x: 0, y: 10 },
      end: { x: 200, y: 10 },
      routing: 'straight',
      connector: false,
      stroke: { width: 3, fill: color, dash: 'dash' },
    },
    {
      id: 'text',
      type: 'textFrame',
      transform: { ...transform, y: 180 },
      zIndex: 4,
      text: textFrame('paragraph', true),
    },
    {
      id: 'group',
      type: 'group',
      transform: { x: 240, y: 180, width: 260, height: 160 },
      zIndex: 5,
      children: [
        {
          id: 'nested-rectangle',
          type: 'shape',
          transform: { x: 0, y: 0, width: 80, height: 60 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#00ff00' } } },
        },
        {
          id: 'nested-image',
          type: 'image',
          transform: { x: 90, y: 0, width: 160, height: 100 },
          zIndex: 2,
          resourceId: 'image-resource',
          fit: 'contain',
          alt: 'Resolved image',
        },
      ],
    },
  ],
  animations: [],
});

const unsupportedSlide = (): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'unsupported-slide',
  title: 'Unsupported native slide',
  background: { kind: 'solid', color },
  elements: [
    {
      id: 'custom',
      type: 'shape',
      transform,
      zIndex: 1,
      geometry: { kind: 'preset', preset: 'cloudCallout' },
      style: {},
    },
    {
      id: 'chart',
      type: 'chart',
      transform,
      zIndex: 2,
      chartType: 'unsupported',
      sourceChartType: 'radarChart',
      showLegend: false,
      showDataLabels: false,
    },
    { id: 'formula', type: 'formula', transform, zIndex: 3, latex: 'x^2', display: 'block', color },
    {
      id: 'diagram',
      type: 'diagram',
      transform,
      zIndex: 4,
      diagramType: 'process',
      nodes: [],
      edges: [],
    },
    {
      id: 'audio',
      type: 'audio',
      transform,
      zIndex: 5,
      resourceId: 'audio-resource',
      playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
      title: 'Audio',
    },
    {
      id: 'video',
      type: 'video',
      transform,
      zIndex: 6,
      resourceId: 'video-resource',
      playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
      title: 'Video',
    },
    {
      id: 'table',
      type: 'table',
      transform,
      zIndex: 7,
      columnWidths: [200],
      rowHeights: [100],
      rows: [
        {
          id: 'row',
          cells: [
            {
              id: 'cell',
              rowSpan: 1,
              columnSpan: 1,
              text: textFrame('cell-text'),
              style: {},
            },
          ],
        },
      ],
    },
  ],
  transition: { type: 'fade', duration: 0.5 },
  animations: [
    // fade/move 等效果已由播放解析器渲染，只有 color 仍是"表示但不渲染"。
    {
      id: 'animation',
      targetId: 'custom',
      trigger: 'on-enter',
      effect: 'color',
      start: 0,
      duration: 1,
    },
  ],
});

const chartSlide = (
  chartType: ReachDeckCategoricalChartElementV2['chartType'],
  values: Array<number | null> = [4, null, -2],
): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: `${chartType}-slide`,
  title: `${chartType} slide`,
  background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
  elements: [
    {
      id: `${chartType}-chart`,
      type: 'chart',
      transform: { x: 20, y: 20, width: 360, height: 220 },
      zIndex: 1,
      chartType,
      title: 'Cached results',
      categories: ['Before', 'During', 'After'],
      series: [
        { id: 'series-a', name: 'Class A', values, color: { kind: 'srgb', value: '#2563EB' } },
        { id: 'series-b', name: 'Class B', values: [null, null, null] },
      ],
      showLegend: true,
      showDataLabels: true,
    },
  ],
  animations: [],
});

describe('NativeV2SlideRenderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('retains loaded images while renewing and adopts the spare ticket on an error', () => {
    const slide = supportedSlide();
    slide.elements = [
      {
        id: 'image',
        type: 'image',
        resourceId: 'resource',
        fit: 'contain',
        alt: 'Forest',
        transform,
        zIndex: 1,
      },
    ];
    const onMediaError = vi.fn();
    const onMediaLoaded = vi.fn();
    const render = (src: string) =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          resourceUrlsById={{ resource: src }}
          stage={{ width: 800, height: 450 }}
          onMediaError={onMediaError}
          onMediaLoaded={onMediaLoaded}
        />,
      );
    act(() => render('/first.png'));
    act(() => container.querySelector('img')!.dispatchEvent(new Event('load')));
    expect(onMediaLoaded).toHaveBeenCalledWith('resource', '/first.png');
    act(() => render('/spare.png'));
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/first.png');
    act(() => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(onMediaError).toHaveBeenCalledWith('resource', '/first.png');
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/spare.png');
  });

  it('holds playing native video and restores playback properties after replacing a failed source', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const slide = supportedSlide();
    slide.elements = [
      {
        id: 'video',
        type: 'video',
        resourceId: 'resource',
        title: 'Video',
        transform,
        zIndex: 1,
        playback: { autoplay: false, loop: false, startAt: 0, volume: 1 },
      },
    ];
    const onMediaError = vi.fn();
    const render = (src: string) =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          resourceUrlsById={{ resource: src }}
          stage={{ width: 800, height: 450 }}
          onMediaError={onMediaError}
        />,
      );
    try {
      act(() => render('/first.mp4'));
      const video = container.querySelector<HTMLVideoElement>('video')!;
      Object.defineProperty(video, 'paused', { configurable: true, value: false });
      Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
      video.currentTime = 12;
      video.playbackRate = 1.5;
      video.volume = 0.4;
      video.muted = true;
      act(() => {
        video.dispatchEvent(new Event('play'));
        video.dispatchEvent(new Event('timeupdate'));
      });
      act(() => render('/spare.mp4'));
      expect(video.getAttribute('src')).toBe('/first.mp4');
      // An error can arrive between timeupdate events, after the browser has paused fetching.
      video.currentTime = 18;
      Object.defineProperty(video, 'paused', { configurable: true, value: true });
      act(() => video.dispatchEvent(new Event('error')));
      expect(video.getAttribute('src')).toBe('/spare.mp4');
      video.currentTime = 0;
      video.playbackRate = 1;
      video.volume = 1;
      video.muted = false;
      Object.defineProperty(video, 'readyState', { configurable: true, value: 0 });
      act(() => {
        video.dispatchEvent(new Event('timeupdate'));
        video.dispatchEvent(new Event('ratechange'));
        video.dispatchEvent(new Event('volumechange'));
        video.dispatchEvent(new Event('pause'));
      });
      await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
      expect(video.currentTime).toBe(18);
      expect(video.playbackRate).toBe(1.5);
      expect(video.volume).toBe(0.4);
      expect(video.muted).toBe(true);
      expect(play).toHaveBeenCalledTimes(1);
      expect(onMediaError).toHaveBeenCalledWith('resource', '/first.mp4');
    } finally {
      play.mockRestore();
    }
  });

  it('never retains an old loaded image after the owning media scope changes', () => {
    const slide = supportedSlide();
    slide.elements = [
      {
        id: 'image',
        type: 'image',
        resourceId: 'resource',
        fit: 'contain',
        alt: 'Image',
        transform,
        zIndex: 1,
      },
    ];
    const onMediaError = vi.fn();
    const render = (scope: string, src: string) =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          mediaScopeKey={scope}
          resourceUrlsById={{ resource: src }}
          stage={{ width: 800, height: 450 }}
          onMediaError={onMediaError}
        />,
      );
    act(() => render('old-document:old-key', '/old.png'));
    act(() => container.querySelector('img')!.dispatchEvent(new Event('load')));
    act(() => render('new-document:new-key', '/new.png'));
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/new.png');
  });

  it('allows transient buffering to recover and rotates only after a sustained playing stall', async () => {
    vi.useFakeTimers();
    const slide = supportedSlide();
    slide.elements = [
      {
        id: 'video',
        type: 'video',
        resourceId: 'resource',
        title: 'Video',
        transform,
        zIndex: 1,
        playback: { autoplay: false, loop: false, startAt: 0, volume: 1 },
      },
    ];
    const onMediaError = vi.fn();
    const render = (src: string) =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          resourceUrlsById={{ resource: src }}
          stage={{ width: 800, height: 450 }}
          onMediaError={onMediaError}
        />,
      );
    try {
      act(() => render('/first.mp4'));
      const video = container.querySelector<HTMLVideoElement>('video')!;
      Object.defineProperty(video, 'paused', { configurable: true, value: false });
      act(() => video.dispatchEvent(new Event('play')));
      act(() => render('/spare.mp4'));
      act(() => video.dispatchEvent(new Event('stalled')));
      await act(async () => vi.advanceTimersByTimeAsync(4_000));
      act(() => video.dispatchEvent(new Event('canplay')));
      await act(async () => vi.advanceTimersByTimeAsync(8_000));
      expect(video.getAttribute('src')).toBe('/first.mp4');
      expect(onMediaError).not.toHaveBeenCalled();
      act(() => video.dispatchEvent(new Event('waiting')));
      await act(async () => vi.advanceTimersByTimeAsync(8_000));
      expect(video.getAttribute('src')).toBe('/spare.mp4');
      expect(onMediaError).toHaveBeenCalledWith('resource', '/first.mp4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a neutral fallback when an image URL fails and recovers for a new source', () => {
    const slide = supportedSlide();
    slide.elements = [
      {
        id: 'image',
        type: 'image',
        resourceId: 'image-resource',
        fit: 'contain',
        alt: 'Forest',
        transform,
        zIndex: 1,
      },
    ];
    const render = (url: string) =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          resourceUrlsById={{ 'image-resource': url }}
          stage={{ width: 800, height: 450 }}
        />,
      );
    act(() => render('/image.png'));
    const image = container.querySelector('img')!;
    act(() => image.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(
      container.querySelector('svg[data-native-v2-element-id="image"]')?.getAttribute('aria-label'),
    ).toBe('Forest');
    act(() => render('/replacement.png'));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/replacement.png');
  });

  it.each([false, true])(
    'retains image crop diagnostics when the resource is missing=%s',
    (missing) => {
      const slide = supportedSlide();
      slide.elements = [
        {
          id: 'image',
          type: 'image',
          resourceId: 'image-resource',
          fit: 'contain',
          alt: 'Forest',
          transform,
          zIndex: 1,
          crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
        },
      ];
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            slide={slide}
            resourceUrlsById={missing ? {} : { 'image-resource': '/forest.png' }}
            stage={{ width: 800, height: 450 }}
          />,
        ),
      );
      expect(
        container.querySelector('[data-native-v2-unsupported-element="image"]'),
      ).not.toBeNull();
      expect(container.querySelector('svg[data-native-v2-element-id="image"]')).toBeNull();
    },
  );

  it('uses the neutral image placeholder only for unresolved resource diagnostics', () => {
    const slide = supportedSlide();
    slide.elements = [
      {
        id: 'image',
        type: 'image',
        resourceId: 'image-resource',
        fit: 'contain',
        alt: 'Forest',
        transform,
        zIndex: 1,
      },
    ];
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          resourceUrlsById={{}}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    expect(container.querySelector('svg[data-native-v2-element-id="image"]')).not.toBeNull();
    expect(container.querySelector('[data-native-v2-unsupported-element="image"]')).toBeNull();
  });

  it.each(['ellipse', 'roundRect', 'custom'] as const)(
    'keeps %s geometry, stroke and selection when an image fill is unresolved',
    (kind) => {
      const slide = supportedSlide();
      slide.elements = [
        {
          id: 'missing-fill',
          type: 'shape',
          transform: { x: 10, y: 20, width: 200, height: 100, rotation: 25 },
          zIndex: 1,
          geometry:
            kind === 'custom'
              ? {
                  kind: 'custom',
                  viewBox: { width: 400, height: 200 },
                  path: 'M0 0 L400 0 L200 200 Z',
                }
              : { kind: 'preset', preset: kind },
          style: {
            fill: { kind: 'image', resourceId: 'missing-resource', mode: 'stretch' },
            stroke: { width: 2, fill: { kind: 'srgb', value: '#112233' } },
          },
        },
      ];
      const select = vi.fn();
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            slide={slide}
            resourceUrlsById={{}}
            stage={{ width: 800, height: 450 }}
            onElementSelect={select}
          />,
        ),
      );
      const shape = container.querySelector<HTMLElement>(
        'div[data-native-v2-element-id="missing-fill"]',
      );
      expect(shape).not.toBeNull();
      expect(shape?.style.transform).toContain('rotate(25deg)');
      const placeholder = shape?.querySelector<SVGSVGElement>(
        '[data-native-v2-image-fill-placeholder]',
      );
      expect(placeholder).not.toBeNull();
      if (kind === 'custom') {
        expect(placeholder?.getAttribute('viewBox')).toBe('0 0 400 200');
        expect(placeholder?.querySelector('clipPath path')?.getAttribute('d')).toBe(
          'M0 0 L400 0 L200 200 Z',
        );
        expect(placeholder?.querySelector('g[clip-path]')).not.toBeNull();
        expect(
          shape?.querySelector('[data-native-v2-custom-geometry] > path')?.getAttribute('stroke'),
        ).toBe('#112233');
      } else {
        expect(placeholder?.style.borderRadius).toBe(kind === 'ellipse' ? '50%' : '16.667px');
        expect(shape?.style.borderWidth).toBe('2px');
      }
      act(() => shape!.click());
      expect(select).toHaveBeenCalledWith('missing-fill');
      expect(container.querySelector('[data-native-v2-unsupported-element="shape"]')).toBeNull();
    },
  );

  it('fits a learner viewport without shrinking the outer measurement slot', () => {
    const render = (viewportMaxWidth: number) =>
      root.render(
        <NativeV2SlideRenderer
          viewportMaxWidth={viewportMaxWidth}
          resourceUrlsById={{}}
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      );
    act(() => render(640));
    const slot = container.querySelector<HTMLElement>('[data-native-v2-slide-renderer]')!;
    const viewport = container.querySelector<HTMLElement>('[data-native-v2-viewport]')!;
    expect(slot.style.maxWidth).toBe('');
    expect(viewport.style.maxWidth).toBe('640px');
    expect(viewport.style.marginInline).toBe('auto');
    act(() => render(800));
    expect(slot.style.maxWidth).toBe('');
    expect(viewport.style.maxWidth).toBe('800px');
  });

  it('renders supported native shapes, lines, text, lists, groups, and explicit image resources', () => {
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          maxWidth={640}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const stage = container.querySelector<HTMLElement>('[data-native-v2-stage]');
    expect(
      container.querySelector<HTMLElement>('[data-native-v2-slide-renderer]')?.style.maxWidth,
    ).toBe('640px');
    expect(stage?.style.width).toBe('800px');
    expect(stage?.style.height).toBe('450px');
    expect(stage?.style.background).toContain('linear-gradient');

    const rectangle = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="rectangle"]',
    );
    expect(rectangle?.style.background).toBe('rgb(18, 52, 86)');
    expect(rectangle?.style.borderWidth).toBe('2px');
    const ellipse = container.querySelector<HTMLElement>('[data-native-v2-element-id="ellipse"]');
    expect(ellipse?.style.borderRadius).toBe('50%');
    expect(ellipse?.style.background).toContain('linear-gradient');

    const line = container.querySelector<SVGLineElement>('[data-native-v2-element-id="line"] line');
    expect(line?.getAttribute('stroke')).toBe('#123456');
    expect(line?.getAttribute('stroke-dasharray')).toBe('6 4');
    // 列表经共享富文本渲染器输出为标准 ul/li。
    expect(container.querySelector('[data-native-v2-element-id="text"] ul li')).not.toBeNull();
    expect(container.textContent).toContain('Native text');

    const group = container.querySelector('[data-native-v2-group]');
    expect(group?.querySelector('[data-native-v2-element-id="nested-rectangle"]')).not.toBeNull();
    const image = group?.querySelector<HTMLImageElement>(
      '[data-native-v2-resource-id="image-resource"]',
    );
    expect(image?.src).toBe('https://assets.example.test/image.png');
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('renders the host stage overlay only when provided, above elements and pointer-transparent', () => {
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    // 学生/教师播放不传叠加层：舞台里不多出任何节点。
    expect(container.querySelector('[data-native-v2-stage-overlay]')).toBeNull();
    const stageChildren = container.querySelector('[data-native-v2-stage]')?.childElementCount;

    const onElementSelect = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementSelect={onElementSelect}
          resourceUrlsById={{}}
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
          stageOverlay={<span data-host-overlay-node>1</span>}
        />,
      ),
    );
    const overlay = container.querySelector<HTMLElement>('[data-native-v2-stage-overlay]');
    expect(overlay?.parentElement?.hasAttribute('data-native-v2-stage')).toBe(true);
    expect(container.querySelector('[data-native-v2-stage]')?.childElementCount).toBe(
      (stageChildren ?? 0) + 1,
    );
    expect(overlay?.style.pointerEvents).toBe('none');
    expect(overlay?.style.getPropertyValue('--native-v2-stage-scale')).not.toBe('');
    expect(overlay?.querySelector('[data-host-overlay-node]')).not.toBeNull();
    // 元素点击照常落到元素上。
    act(() =>
      container.querySelector<HTMLElement>('[data-native-v2-element-id="rectangle"]')?.click(),
    );
    expect(onElementSelect).toHaveBeenCalledWith('rectangle');
  });

  it('addresses editable table text by element and cell ID while playback stays read-only', () => {
    const slide = unsupportedSlide();
    const onEdit = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          stage={{ width: 800, height: 450 }}
          resourceUrlsById={{}}
          onTextFrameDoubleClick={onEdit}
        />,
      ),
    );
    act(() =>
      container
        .querySelector('[data-native-v2-table-cell="cell"]')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(onEdit).toHaveBeenCalledWith('table', 'cell');
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          stage={{ width: 800, height: 450 }}
          resourceUrlsById={{}}
          editingElementId="table"
          editingCellId="cell"
          renderEditingTextFrame={() => <textarea aria-label="Cell editor" />}
        />,
      ),
    );
    expect(container.querySelector('[data-native-v2-table-cell="cell"] textarea')).not.toBeNull();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          slide={slide}
          stage={{ width: 800, height: 450 }}
          resourceUrlsById={{}}
        />,
      ),
    );
    expect(container.querySelector('textarea, [contenteditable="true"]')).toBeNull();
    act(() =>
      container
        .querySelector('[data-native-v2-table-cell="cell"]')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('renders normally when the slide carries narration and duration (v2 schema extension)', () => {
    // narration/duration 是渲染器尚未消费的新增可选字段：本用例只验证它们
    // 的出现不会破坏既有渲染（类型透传 + 数据可达），字幕 UI 留给管线整合任务。
    const slide: ReachDeckNativeSlideV2 = {
      ...supportedSlide(),
      duration: 9.5,
      narration: {
        audioResourceId: 'audio-narration',
        segments: [
          { text: '第一段讲稿。', start: 0, end: 4 },
          { text: '第二段讲稿。', start: 4, end: 9.5 },
        ],
      },
    };

    expect(() =>
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
            slide={slide}
            stage={{ width: 800, height: 450 }}
          />,
        ),
      ),
    ).not.toThrow();

    const stage = container.querySelector<HTMLElement>('[data-native-v2-stage]');
    expect(stage).not.toBeNull();
    expect(container.querySelector('[data-native-v2-element-id="rectangle"]')).not.toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('renders a slide whose animation targets a deleted element and ignores that animation', () => {
    // 孤儿动画允许保存与发布：渲染不能因此抛错，也不能影响其他元素的显示。
    const slide: ReachDeckNativeSlideV2 = {
      ...supportedSlide(),
      animations: [
        {
          id: 'narration-entrance:deleted',
          targetId: 'deleted',
          trigger: 'on-enter',
          effect: 'fade',
          start: 1,
          duration: 0.4,
        },
      ],
    };

    expect(() =>
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            currentTime={0}
            resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
            slide={slide}
            stage={{ width: 800, height: 450 }}
          />,
        ),
      ),
    ).not.toThrow();
    const rectangle = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="rectangle"]',
    );
    expect(rectangle).not.toBeNull();
    expect(rectangle?.style.opacity).not.toBe('0');
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('mounts scientific visuals without requiring a poster display URL', () => {
    const scientific = scientificElement();
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'scientific-slide',
      title: 'Scientific slide',
      background: { kind: 'solid', color },
      elements: [scientific],
      animations: [],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    expect(container.querySelector('[data-native-v2-element-id="scientific"]')).not.toBeNull();
    expect(container.querySelector('[data-scientific-frame]')).not.toBeNull();
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('keeps historical/PPTX paragraph shifts but renders native multi-paragraph text unshifted', () => {
    const compatibilitySlide = (textCompatibility?: 'native' | 'pptx') => {
      const slide = supportedSlide();
      if (textCompatibility !== undefined) slide.textCompatibility = textCompatibility;
      const element = slide.elements.find((candidate) => candidate.type === 'textFrame');
      if (element?.type !== 'textFrame') throw new Error('text fixture missing');
      element.text.doc = {
        type: 'doc',
        content: ['First', 'Second'].map((value) => ({
          type: 'paragraph',
          attrs: { lineHeightPx: 16 },
          content: [
            {
              type: 'text',
              text: value,
              marks: [{ type: 'textStyle', attrs: { fontSize: '20px' } }],
            },
          ],
        })),
      };
      return slide;
    };

    for (const compatibility of [undefined, 'pptx'] as const) {
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
            slide={compatibilitySlide(compatibility)}
            stage={{ width: 800, height: 450 }}
          />,
        ),
      );
      const paragraphs = container.querySelectorAll<HTMLElement>(
        '[data-native-v2-element-id="text"] p',
      );
      expect([...paragraphs].map((paragraph) => paragraph.style.marginTop)).toEqual([
        '-4px',
        '-4px',
      ]);
    }

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={compatibilitySlide('native')}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    const nativeParagraphs = container.querySelectorAll<HTMLElement>(
      '[data-native-v2-element-id="text"] p',
    );
    expect([...nativeParagraphs].map((paragraph) => paragraph.style.marginTop)).toEqual(['', '']);
  });

  it('renders a resolved standalone audio control with positioning, playback flags and an accessible label', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'audio-slide',
      title: 'Audio slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'audio-control',
          type: 'audio',
          transform: { x: 25, y: 35, width: 240, height: 54 },
          zIndex: 7,
          resourceId: 'audio-resource',
          playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
          title: 'Story narration',
        },
      ],
      narration: { segments: [{ text: 'Text-only manuscript.' }] },
      animations: [],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          audioControlLabel={(title) => `Audio: ${title}`}
          resourceUrlsById={{ 'audio-resource': 'https://assets.example.test/story.mp3' }}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const audio = document.body.querySelector<HTMLAudioElement>(
      '[data-native-v2-element-id="audio-control"] audio',
    );
    expect(audio?.src).toBe('https://assets.example.test/story.mp3');
    expect(audio?.controls).toBe(true);
    expect(audio?.autoplay).toBe(false);
    expect(audio?.loop).toBe(false);
    expect(audio?.getAttribute('aria-label')).toBe('Audio: Story narration');
    const mediaBox = container.querySelector<HTMLElement>('[data-native-v2-media="audio"]');
    expect(mediaBox?.style.left).toBe('25px');
    expect(mediaBox?.style.top).toBe('35px');
    expect(mediaBox?.style.width).toBe('240px');
    expect(mediaBox?.style.height).toBe('54px');
    expect(mediaBox?.style.zIndex).toBe('7');
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('applies standalone audio start/end and volume bounds without joining narration state', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'bounded-audio-slide',
      title: 'Bounded audio slide',
      background: { kind: 'none' },
      elements: [
        {
          id: 'bounded-audio',
          type: 'audio',
          transform: { x: 0, y: 0, width: 200, height: 40 },
          zIndex: 1,
          resourceId: 'audio-resource',
          playback: { startAt: 2, endAt: 5, autoplay: false, loop: false, volume: 0.4 },
          title: 'Excerpt',
        },
      ],
      narration: { segments: [{ text: 'Independent text-only manuscript.' }] },
      animations: [],
    };
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{ 'audio-resource': 'https://assets.example.test/excerpt.mp3' }}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    const audio = document.body.querySelector<HTMLAudioElement>('audio')!;
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => undefined);

    act(() => audio.dispatchEvent(new Event('loadedmetadata')));
    expect(audio.currentTime).toBe(2);
    expect(audio.volume).toBe(0.4);
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    audio.currentTime = 5;
    act(() => audio.dispatchEvent(new Event('timeupdate')));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(2);
  });

  it('surfaces unresolved standalone audio instead of emitting a broken control', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'audio-slide',
      title: 'Audio slide',
      background: { kind: 'none' },
      elements: [
        {
          id: 'audio-control',
          type: 'audio',
          transform: { x: 25, y: 35, width: 240, height: 54 },
          zIndex: 7,
          resourceId: 'missing-audio',
          playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
          title: 'Missing audio',
        },
      ],
      animations: [],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    expect(container.querySelector('audio')).toBeNull();
    expect(container.querySelector('[data-native-v2-unsupported-element="audio"]')).not.toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')?.textContent).toContain(
      'Audio resource missing-audio has no explicit display URL.',
    );
  });

  it('renders table elements as positioned cells with fills, borders and text', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'table-slide',
      title: 'Table slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'table-1',
          type: 'table',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          columnWidths: [100, 100],
          rowHeights: [50, 50],
          rows: [
            {
              id: 'row-1',
              cells: [
                {
                  id: 'cell-a',
                  rowSpan: 1,
                  columnSpan: 1,
                  text: textFrame('cell-a'),
                  style: {
                    fill: { kind: 'solid', color: { kind: 'srgb', value: '#4874CB' } },
                    stroke: { width: 1, fill: { kind: 'srgb', value: '#FEFEFE' } },
                  },
                },
                {
                  id: 'cell-b',
                  rowSpan: 1,
                  columnSpan: 1,
                  text: textFrame('cell-b'),
                  style: {},
                },
              ],
            },
            {
              id: 'row-2',
              cells: [
                {
                  id: 'cell-merged',
                  rowSpan: 1,
                  columnSpan: 2,
                  text: textFrame('cell-merged'),
                  style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#FFEE00' } } },
                },
              ],
            },
          ],
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const table = container.querySelector<HTMLElement>('[data-native-v2-element-id="table-1"]');
    expect(table).not.toBeNull();
    const cells = container.querySelectorAll<HTMLElement>('[data-native-v2-table-cell]');
    expect(cells).toHaveLength(3);
    const first = container.querySelector<HTMLElement>('[data-native-v2-table-cell="cell-a"]');
    expect(first?.style.left).toBe('0px');
    expect(first?.style.top).toBe('0px');
    expect(first?.style.width).toBe('100px');
    expect(first?.style.height).toBe('50px');
    expect(first?.style.background).toBe('rgb(72, 116, 203)');
    expect(first?.style.borderWidth).toBe('1px');
    expect(first?.textContent).toContain('Native text');
    const second = container.querySelector<HTMLElement>('[data-native-v2-table-cell="cell-b"]');
    expect(second?.style.left).toBe('100px');
    const merged = container.querySelector<HTMLElement>(
      '[data-native-v2-table-cell="cell-merged"]',
    );
    expect(merged?.style.top).toBe('50px');
    expect(merged?.style.width).toBe('200px');
    // 表格现在原生渲染,不再是 UNSUPPORTED_ELEMENT。
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
  });

  it('renders elbow lines as orthogonal polylines positioned by the bend fraction', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'elbow-slide',
      title: 'Elbow slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'elbow-mid',
          type: 'line',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          start: { x: 0, y: 0 },
          end: { x: 200, y: 100, marker: 'arrow' },
          routing: 'elbow',
          bend: 0.25,
          connector: true,
          stroke: { width: 2, fill: { kind: 'srgb', value: '#b52121' } },
        },
        {
          // bentConnector2:bend 缺省按 1,折点与终点竖直段重合,去重成三点。
          id: 'elbow-corner',
          type: 'line',
          transform: { x: 10, y: 150, width: 200, height: 100 },
          zIndex: 2,
          start: { x: 0, y: 100 },
          end: { x: 200, y: 0 },
          routing: 'elbow',
          connector: true,
          stroke: { width: 2, fill: { kind: 'srgb', value: '#b52121' } },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const middle = container.querySelector<SVGPathElement>(
      '[data-native-v2-element-id="elbow-mid"] > path',
    );
    expect(middle?.getAttribute('d')).toBe('M 0 0 L 50 0 L 50 100 L 200 100');
    expect(middle?.getAttribute('fill')).toBe('none');
    expect(middle?.getAttribute('marker-end')).toContain('elbow-mid-end');
    const corner = container.querySelector<SVGPathElement>(
      '[data-native-v2-element-id="elbow-corner"] > path',
    );
    expect(corner?.getAttribute('d')).toBe('M 0 100 L 200 100 L 200 0');
    // Elbow 现在原生渲染,不再有 UNSUPPORTED_LINE 提示。
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('pads degenerate line boxes so zero-height and zero-width lines still render', () => {
    // 导入器把 cy=0 的线兜底成 0.01 高;Chromium 按 1/64px 取整后 SVG 视口为 0 而不渲染。
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'thin-line-slide',
      title: 'Thin line slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'flat-line',
          type: 'line',
          transform: { x: 59.15, y: 292.95, width: 223.35, height: 0.01 },
          zIndex: 1,
          start: { x: 0, y: 0 },
          end: { x: 223.35, y: 0 },
          routing: 'straight',
          connector: false,
          stroke: { width: 2, fill: { kind: 'srgb', value: '#6b00b9' } },
        },
        {
          id: 'upright-line',
          type: 'line',
          transform: { x: 100, y: 20, width: 0.01, height: 80 },
          zIndex: 2,
          start: { x: 0, y: 0 },
          end: { x: 0, y: 80 },
          routing: 'straight',
          connector: false,
          stroke: { width: 2, fill: { kind: 'srgb', value: '#6b00b9' } },
        },
        {
          id: 'regular-line',
          type: 'line',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 3,
          start: { x: 0, y: 0 },
          end: { x: 200, y: 100 },
          routing: 'straight',
          connector: false,
          stroke: { width: 2, fill: { kind: 'srgb', value: '#6b00b9' } },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 960, height: 540 }}
        />,
      ),
    );

    const flat = container.querySelector<SVGSVGElement>('[data-native-v2-element-id="flat-line"]');
    expect(flat?.getAttribute('viewBox')).toBe('0 -1 223.35 2.01');
    expect(flat?.style.top).toBe('291.95px');
    expect(flat?.style.height).toBe('2.01px');
    expect(flat?.style.width).toBe('223.35px');
    const flatLine = flat?.querySelector('line');
    expect(flatLine?.getAttribute('y1')).toBe('0');
    expect(flatLine?.getAttribute('x2')).toBe('223.35');

    const upright = container.querySelector<SVGSVGElement>(
      '[data-native-v2-element-id="upright-line"]',
    );
    expect(upright?.getAttribute('viewBox')).toBe('-1 0 2.01 80');
    expect(upright?.style.left).toBe('99px');
    expect(upright?.style.width).toBe('2.01px');

    const regular = container.querySelector<SVGSVGElement>(
      '[data-native-v2-element-id="regular-line"]',
    );
    expect(regular?.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(regular?.style.top).toBe('10px');
  });

  it('clamps pathological stroke widths to the element bounds with an advisory diagnostic', () => {
    // 修复前由组坐标缩放产生的畸形文档可能带上千 pt 的描边;渲染时钳制到
    // 元素盒尺寸,避免整页被描边涂黑,同时保留 advisory 诊断。
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'clamped-stroke-slide',
      title: 'Clamped stroke slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'huge-stroke-rect',
          type: 'shape',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rectangle' },
          style: {
            fill: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
            stroke: { width: 2381, fill: { kind: 'srgb', value: '#000000' } },
          },
        },
        {
          id: 'huge-stroke-line',
          type: 'line',
          transform: { x: 10, y: 150, width: 200, height: 1 },
          zIndex: 2,
          start: { x: 0, y: 0 },
          end: { x: 200, y: 0 },
          routing: 'straight',
          connector: false,
          stroke: { width: 7144, fill: { kind: 'srgb', value: '#000000' } },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const rectangle = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="huge-stroke-rect"]',
    );
    // 钳制到盒子较长边 200pt,而不是 2381pt。
    expect(rectangle?.style.borderWidth).toBe('200px');
    const line = container.querySelector<SVGLineElement>(
      '[data-native-v2-element-id="huge-stroke-line"] line',
    );
    expect(Number(line?.getAttribute('stroke-width'))).toBe(200);
    // 元素主体仍然渲染(advisory 不替换为诊断占位),面板里有说明。
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    const panel = container.querySelector<HTMLElement>('[data-native-v2-diagnostics]');
    expect(panel?.textContent).toContain('clamped at render time');
  });

  it('renders image fills on css-box shapes as background images', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'image-fill-slide',
      title: 'Image fill slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'photo-fill',
          type: 'shape',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: {
            fill: { kind: 'image', resourceId: 'image-resource', mode: 'stretch' },
            stroke: { width: 2, fill: { kind: 'srgb', value: '#000000' } },
          },
        },
        {
          id: 'texture-fill',
          type: 'shape',
          transform: { x: 10, y: 130, width: 200, height: 100 },
          zIndex: 2,
          geometry: { kind: 'preset', preset: 'rect' },
          style: { fill: { kind: 'image', resourceId: 'image-resource', mode: 'tile' } },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const photo = container.querySelector<HTMLElement>('[data-native-v2-element-id="photo-fill"]');
    expect(photo?.style.backgroundImage).toContain('image.png');
    expect(photo?.style.backgroundSize).toBe('100% 100%');
    expect(photo?.style.backgroundRepeat).toBe('no-repeat');
    // 描边照常渲染。
    expect(photo?.style.borderWidth).toBe('2px');
    const texture = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="texture-fill"]',
    );
    expect(texture?.style.backgroundImage).toContain('image.png');
    // PPT 恒等平铺:原始尺寸自左上角重复。
    expect(texture?.style.backgroundSize).toBe('auto');
    expect(texture?.style.backgroundRepeat).toBe('repeat');
    expect(texture?.style.backgroundPosition).toBe('left top');
    // 图片填充为一等渲染能力:不再出现降级诊断。
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('renders image fills clipped into svg-geometry shapes', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'svg-image-fill-slide',
      title: 'Svg image fill slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'custom-photo',
          type: 'shape',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          geometry: {
            kind: 'custom',
            viewBox: { width: 200, height: 100 },
            path: 'M0 0 L200 0 L100 100 Z',
          },
          style: { fill: { kind: 'image', resourceId: 'image-resource', mode: 'stretch' } },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const svg = container.querySelector('[data-native-v2-custom-geometry]');
    const image = svg?.querySelector('image');
    expect(image?.getAttribute('href')).toBe('https://assets.example.test/image.png');
    expect(image?.getAttribute('clip-path')).toContain('url(');
    expect(svg?.querySelector('clipPath path')?.getAttribute('d')).toBe('M0 0 L200 0 L100 100 Z');
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('renders stretch image fill insets as an oversized background layer', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'inset-fill-slide',
      title: 'Inset fill slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'bleed-fill',
          type: 'shape',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: {
            fill: {
              kind: 'image',
              resourceId: 'image-resource',
              mode: 'stretch',
              // 负值出血:图片放大到 140%x150%,向左上平移后被盒子裁剪。
              insets: { left: -0.2, top: -0.5, right: -0.2, bottom: 0 },
            },
          },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const shape = container.querySelector<HTMLElement>('[data-native-v2-element-id="bleed-fill"]');
    expect(shape?.style.backgroundImage).toContain('image.png');
    expect(shape?.style.backgroundSize).toBe('140% 150%');
    // 位置以元素盒 px 表达:left*width = -40px, top*height = -50px;
    // CSS background 天然被元素盒裁剪,出血部分不可见。
    expect(shape?.style.backgroundPosition).toBe('-40px -50px');
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('renders image element strokes as css borders', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'image-stroke-slide',
      title: 'Image stroke slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'framed-image',
          type: 'image',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          resourceId: 'image-resource',
          fit: 'stretch',
          alt: 'Framed image',
          stroke: { width: 2, fill: { kind: 'srgb', value: '#445566' }, dash: 'dash' },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const image = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="framed-image"]',
    );
    expect(image?.style.borderWidth).toBe('2px');
    expect(image?.style.borderStyle).toBe('dashed');
    expect(image?.style.borderColor).toBe('rgb(68, 85, 102)');
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
  });

  it('reports image fills whose resource has no display URL', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'missing-image-fill-slide',
      title: 'Missing image fill slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      animations: [],
      elements: [
        {
          id: 'orphan-fill',
          type: 'shape',
          transform: { x: 10, y: 10, width: 200, height: 100 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: { fill: { kind: 'image', resourceId: 'missing-resource', mode: 'stretch' } },
        },
      ],
    };

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    expect(container.querySelector('[data-native-v2-unsupported-element="shape"]')).toBeNull();
    expect(
      container.querySelector(
        'div[data-native-v2-element-id="orphan-fill"] [data-native-v2-image-fill-placeholder]',
      ),
    ).not.toBeNull();
    const panel = container.querySelector<HTMLElement>('[data-native-v2-diagnostics]');
    expect(panel?.textContent).toContain('no explicit display URL');
  });

  it('renders every unsupported represented feature as a visible read-only diagnostic', () => {
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={unsupportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    for (const type of ['shape', 'chart', 'formula', 'diagram', 'audio', 'video']) {
      expect(
        container.querySelector(`[data-native-v2-unsupported-element="${type}"]`),
      ).not.toBeNull();
    }
    // 表格已原生渲染,不再出现在 unsupported 集里。
    expect(container.querySelector('[data-native-v2-unsupported-element="table"]')).toBeNull();
    expect(container.querySelector('[data-native-v2-table-cell]')).not.toBeNull();
    const panel = container.querySelector<HTMLElement>('[data-native-v2-diagnostics]');
    expect(panel?.textContent).toContain('Preset geometry cloudCallout');
    expect(panel?.textContent).toContain('Transition fade');
    expect(panel?.textContent).not.toContain('Animation color');
    expect(panel?.getAttribute('data-read-only')).toBe('true');
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it.each(['column', 'bar', 'line', 'area', 'pie', 'doughnut'] as const)(
    'renders %s charts as read-only SVG without renderer diagnostics',
    (chartType) => {
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            resourceUrlsById={{}}
            slide={chartSlide(chartType)}
            stage={{ width: 800, height: 450 }}
          />,
        ),
      );

      const chart = container.querySelector<SVGSVGElement>(
        `[data-native-v2-chart-type="${chartType}"]`,
      );
      expect(chart).not.toBeNull();
      expect(chart?.getAttribute('data-read-only')).toBe('true');
      expect(chart?.querySelector('[data-native-v2-chart-title]')?.lastChild?.textContent).toBe(
        'Cached results',
      );
      expect(chart?.querySelector('[data-native-v2-chart-legend]')).not.toBeNull();
      expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
      expect(chart?.outerHTML).not.toMatch(/NaN|Infinity/);
    },
  );

  it('renders positive and negative bars while preserving null gaps', () => {
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={chartSlide('bar')}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const marks = container.querySelectorAll('[data-native-v2-chart-mark^="series-a:"]');
    expect(marks).toHaveLength(2);
    expect(container.querySelector('[data-native-v2-chart-mark="series-a:1"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it.each(['line', 'area'] as const)('breaks %s paths around null values', (chartType) => {
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={chartSlide(chartType)}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    expect(container.querySelectorAll('[data-native-v2-chart-segment^="series-a:"]')).toHaveLength(
      2,
    );
    expect(container.querySelector('[data-native-v2-chart-mark="series-a:1"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it.each(['pie', 'doughnut'] as const)(
    'renders an empty %s safely when every cached value is zero or null',
    (chartType) => {
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            resourceUrlsById={{}}
            slide={chartSlide(chartType, [0, null, 0])}
            stage={{ width: 800, height: 450 }}
          />,
        ),
      );

      expect(container.querySelector('[data-native-v2-chart-empty]')).not.toBeNull();
      expect(container.querySelector('[data-native-v2-chart-mark]')).toBeNull();
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    },
  );

  // Read-only is about the chart's data, not where it sits: a chart selects,
  // moves and resizes like any other element, and there is still no way to edit
  // its series from the canvas.
  it('selects, moves and resizes a chart like any other element', () => {
    const onElementSelect = vi.fn();
    const onElementTransformChange = vi.fn();
    const slide = chartSlide('column');
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementSelect={onElementSelect}
          onElementTransformChange={onElementTransformChange}
          resourceUrlsById={{}}
          selectedElementId="column-chart"
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    act(() => {
      container
        .querySelector<SVGSVGElement>('[data-native-v2-chart-type="column"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onElementSelect).toHaveBeenCalledWith('column-chart');

    const overlay = container.querySelector<HTMLElement>(
      '[data-native-v2-transform-overlay="column-chart"]',
    );
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll('[data-resize-corner]')).toHaveLength(4);
    act(() => {
      overlay?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onElementTransformChange).toHaveBeenLastCalledWith('column-chart', {
      x: 30,
      y: 20,
      width: 360,
      height: 220,
    });
  });

  it('shows the source type for unsupported charts and respects hidden and opacity', () => {
    const visible = unsupportedSlide();
    const unsupported = visible.elements.find((element) => element.id === 'chart');
    if (unsupported?.type !== 'chart') throw new Error('Expected unsupported chart fixture.');
    unsupported.opacity = 0.35;
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={visible}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    const placeholder = container.querySelector<HTMLElement>(
      '[data-native-v2-unsupported-element="chart"]',
    );
    expect(placeholder?.textContent).toContain('radarChart');
    expect(placeholder?.style.opacity).toBe('0.35');

    const hidden = unsupportedSlide();
    const hiddenChart = hidden.elements.find((element) => element.id === 'chart');
    if (hiddenChart?.type !== 'chart') throw new Error('Expected unsupported chart fixture.');
    hiddenChart.hidden = true;
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={hidden}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    expect(container.querySelector('[data-native-v2-unsupported-element="chart"]')).toBeNull();
  });

  it('renders custom geometry as an SVG path with the element fill and stroke', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'custom-slide',
      title: 'Custom geometry slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'freeform',
          type: 'shape',
          transform: { ...transform, width: 800, height: 150 },
          zIndex: 1,
          geometry: {
            kind: 'custom',
            viewBox: { width: 200, height: 100 },
            path: 'M 0 100 L 100 0 C 120 20 180 40 200 100 Z',
          },
          style: {
            fill: { kind: 'solid', color: { kind: 'srgb', value: '#00ff00' } },
            stroke: { width: 2, fill: { kind: 'srgb', value: '#ff0000' }, dash: 'dashDot' },
          },
          text: textFrame('freeform'),
        },
      ],
      animations: [],
    };
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    // 自定义几何按支持内容渲染，不再降级为只读诊断占位。
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    const svg = container.querySelector<SVGSVGElement>(
      '[data-native-v2-element-id="freeform"] svg[data-native-v2-custom-geometry]',
    );
    expect(svg?.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(svg?.getAttribute('preserveAspectRatio')).toBe('none');
    const path = svg?.querySelector('path');
    expect(path?.getAttribute('d')).toBe('M 0 100 L 100 0 C 120 20 180 40 200 100 Z');
    expect(path?.getAttribute('fill')).toBe('#00ff00');
    expect(path?.getAttribute('stroke')).toBe('#ff0000');
    expect(path?.getAttribute('stroke-width')).toBe('2');
    expect(path?.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(path?.getAttribute('stroke-dasharray')).toBe('6 3 1 3');
    const textLayer = container.querySelector<HTMLElement>(
      '[data-native-v2-text-frame]',
    )?.parentElement;
    expect(textLayer?.style.position).toBe('relative');
    expect(textLayer?.style.height).toBe('100%');
    expect(textLayer?.previousElementSibling).toBe(svg);
    expect(textLayer?.textContent).toBe('Native text');
    const panel = container.querySelector<HTMLElement>('[data-native-v2-diagnostics]');
    expect(panel).toBeNull();
  });

  it('supports centered stroke-relative endpoint symbols without changing legacy marker dimensions', () => {
    const slide = supportedSlide();
    const line = slide.elements.find((element) => element.type === 'line');
    if (line?.type !== 'line') throw new Error('Expected line fixture');
    line.start = { ...line.start, marker: 'arrow' };
    line.end = { ...line.end, marker: 'arrow', markerSize: 3, markerAnchor: 'center' };
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    const start = container.querySelector('marker[id$="line-start"]');
    const end = container.querySelector('marker[id$="line-end"]');
    expect(start?.getAttribute('markerWidth')).toBe('8');
    expect(start?.getAttribute('refX')).toBe('6.5');
    expect(start?.getAttribute('viewBox')).toBe('0 0 8 8');
    expect(end?.getAttribute('markerUnits')).toBe('strokeWidth');
    expect(end?.getAttribute('markerWidth')).toBe('3');
    expect(end?.getAttribute('markerHeight')).toBe('3');
    expect(end?.getAttribute('viewBox')).toBe('1 1 6 6');
    expect(end?.getAttribute('refX')).toBe('4');
    expect(end?.getAttribute('refY')).toBe('4');
    for (const markerSize of [0, -1, 101, Infinity, NaN]) {
      line.end.markerSize = markerSize;
      expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/markerSize/);
    }
    line.end.markerSize = 3;
    Object.assign(line.end, { markerAnchor: 'url(javascript:alert(1))' });
    expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/markerAnchor/);
  });

  it('renders radial SVG fills and confines optional text fills to intrinsic content while retaining the editing box', () => {
    const slide = supportedSlide();
    const shape = slide.elements.find((element) => element.type === 'shape');
    const text = slide.elements.find((element) => element.type === 'textFrame');
    if (shape?.type !== 'shape' || text?.type !== 'textFrame')
      throw new Error('Expected shape and text fixtures');
    const radial = {
      kind: 'gradient' as const,
      gradientType: 'radial' as const,
      angle: 0,
      stops: [
        { offset: 0, color },
        { offset: 1, color: { kind: 'srgb' as const, value: '#FFFFFF' } },
      ],
    };
    shape.geometry = {
      kind: 'custom',
      viewBox: { width: 200, height: 200 },
      path: 'M0 0 H200 V200 H0 Z',
    };
    shape.style.fill = radial;
    text.style = { fill: radial, stroke: { width: 2, fill: color } };
    text.fillSizing = 'content';
    text.transform.height = 667;
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    const gradient = container.querySelector(
      `[data-native-v2-element-id="${shape.id}"] radialGradient`,
    );
    expect(gradient?.getAttribute('cx')).toBe('50%');
    expect(gradient?.getAttribute('cy')).toBe('50%');
    expect(gradient?.getAttribute('r')).toBe('50%');
    expect(gradient?.querySelectorAll('stop')).toHaveLength(2);
    const textElement = container.querySelector<HTMLElement>(
      `[data-native-v2-element-id="${text.id}"]`,
    );
    expect(textElement?.style.height).toBe('667px');
    expect(textElement?.style.borderWidth).toBe('2px');
    expect(textElement?.style.background).toBe('transparent');
    const fill = textElement?.querySelector<HTMLElement>('[data-native-v2-content-background]');
    expect(fill?.style.background).toContain('radial-gradient(ellipse 50% 50% at center');
    expect(fill?.style.top).toBe('-4px');
    expect(fill?.style.right).toBe('-8px');
    expect(fill?.parentElement?.style.height).toBe('');
    expect(fill?.parentElement?.style.flexShrink).toBe('0');
    Object.assign(radial, { gradientType: 'unknown' });
    expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/gradientType/);
    radial.gradientType = 'radial';
    Object.assign(text, { fillSizing: 'unknown' });
    expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/fillSizing/);
  });

  it('flips shape geometry but keeps text unmirrored like PowerPoint, including inside flipped groups', () => {
    const flippedText = (
      id: string,
      flips: { flipHorizontal?: boolean; flipVertical?: boolean },
    ): ReachDeckNativeSlideV2['elements'][number] => ({
      id,
      type: 'textFrame',
      transform: { ...transform, ...flips },
      zIndex: 1,
      text: textFrame(id),
    });
    const slide: ReachDeckNativeSlideV2 = {
      ...supportedSlide(),
      elements: [
        flippedText('plain', {}),
        flippedText('flip-h', { flipHorizontal: true }),
        flippedText('flip-v', { flipVertical: true }),
        flippedText('flip-hv', { flipHorizontal: true, flipVertical: true }),
        {
          id: 'shape-flip-h',
          type: 'shape',
          transform: { ...transform, flipHorizontal: true },
          zIndex: 2,
          geometry: { kind: 'preset', preset: 'rect' },
          style: { fill: { kind: 'solid', color } },
          text: textFrame('shape-flip-h'),
        },
        {
          id: 'group-flip-h',
          type: 'group',
          transform: { ...transform, flipHorizontal: true },
          zIndex: 3,
          children: [
            flippedText('group-child', {}),
            flippedText('group-child-flip-h', { flipHorizontal: true }),
          ],
        },
        {
          ...flippedText('content-fill-flip-h', { flipHorizontal: true }),
          style: {
            fill: {
              kind: 'gradient',
              gradientType: 'linear',
              angle: 0,
              stops: [
                { offset: 0, color },
                { offset: 1, color: { kind: 'srgb', value: '#FFFFFF' } },
              ],
            },
          },
          fillSizing: 'content',
        } as ReachDeckNativeSlideV2['elements'][number],
      ],
    };
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    // 从文字层一路累计到舞台的 CSS 镜像次数：两轴都为偶数是正读，都为奇数是 180° 倒置，
    // 两轴奇偶不同才是左右/上下镜像。
    const textOrientation = (
      id: string,
      layer = '[data-native-v2-text-frame]',
    ): 'upright' | 'rotated-180' | 'mirrored' => {
      const frame = container.querySelector<HTMLElement>(
        `[data-native-v2-element-id="${id}"] ${layer}`,
      );
      if (frame === null) throw new Error(`Missing ${layer} for ${id}`);
      let horizontal = 0;
      let vertical = 0;
      for (
        let node: HTMLElement | null = frame;
        node !== null && !node.hasAttribute('data-native-v2-stage');
        node = node.parentElement
      ) {
        horizontal += node.style.transform.split('scaleX(-1)').length - 1;
        vertical += node.style.transform.split('scaleY(-1)').length - 1;
      }
      if (horizontal % 2 !== vertical % 2) return 'mirrored';
      return horizontal % 2 === 0 ? 'upright' : 'rotated-180';
    };
    const boxTransform = (id: string) =>
      container.querySelector<HTMLElement>(`[data-native-v2-element-id="${id}"]`)?.style.transform;

    expect(boxTransform('plain')).toBe('');
    expect(boxTransform('flip-h')).toBe('scaleX(-1)');
    expect(boxTransform('flip-v')).toBe('scaleY(-1)');
    expect(boxTransform('flip-hv')).toBe('scaleX(-1) scaleY(-1)');
    expect(boxTransform('shape-flip-h')).toBe('scaleX(-1)');
    expect(textOrientation('plain')).toBe('upright');
    expect(textOrientation('flip-h')).toBe('upright');
    expect(textOrientation('flip-v')).toBe('rotated-180');
    expect(textOrientation('flip-hv')).toBe('rotated-180');
    expect(textOrientation('shape-flip-h')).toBe('upright');
    expect(textOrientation('group-child')).toBe('upright');
    expect(textOrientation('group-child-flip-h')).toBe('upright');
    // 按内容尺寸铺的背景属于元素填充：文字回正，背景仍随元素镜像。
    expect(textOrientation('content-fill-flip-h')).toBe('upright');
    expect(textOrientation('content-fill-flip-h', '[data-native-v2-content-background]')).toBe(
      'mirrored',
    );
  });

  it('renders roundRect natively with the OOXML adj corner radius', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'round-rect-slide',
      title: 'Round rect slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'default-round',
          type: 'shape',
          transform,
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'roundRect' },
          style: { fill: { kind: 'solid', color } },
        },
        {
          id: 'adjusted-round',
          type: 'shape',
          transform: { ...transform, y: 140 },
          zIndex: 2,
          geometry: { kind: 'preset', preset: 'roundRect', adjustments: { adj: 25_000 } },
          style: {
            fill: { kind: 'solid', color },
            stroke: { width: 2, fill: { kind: 'srgb', value: '#000000' } },
          },
        },
      ],
      animations: [],
    };
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    // 不再落诊断占位：roundRect 原生渲染。
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
    const defaultRound = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="default-round"]',
    );
    // 200×100 框，默认 adj=16667：半径 = 100 × 0.16667 ≈ 16.667。
    expect(Number.parseFloat(defaultRound?.style.borderRadius ?? '')).toBeCloseTo(16.667, 2);
    expect(defaultRound?.style.background).toBe('rgb(18, 52, 86)');
    const adjustedRound = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="adjusted-round"]',
    );
    expect(Number.parseFloat(adjustedRound?.style.borderRadius ?? '')).toBeCloseTo(25, 5);
    expect(adjustedRound?.style.borderWidth).toBe('2px');
  });

  it('renders arrow/diamond/brace presets as SVG paths with the shape fill and stroke', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'preset-slide',
      title: 'Preset geometry slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'arrow',
          type: 'shape',
          transform,
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rightArrow' },
          style: {
            fill: { kind: 'solid', color: { kind: 'srgb', value: '#00ff00' } },
            stroke: { width: 2, fill: { kind: 'srgb', value: '#ff0000' } },
          },
        },
        {
          id: 'diamond',
          type: 'shape',
          transform: { ...transform, y: 140 },
          zIndex: 2,
          geometry: { kind: 'preset', preset: 'diamond' },
          style: { fill: { kind: 'solid', color } },
        },
        {
          id: 'brace',
          type: 'shape',
          transform: { x: 400, y: 20, width: 40, height: 200 },
          zIndex: 3,
          geometry: { kind: 'preset', preset: 'leftBrace' },
          style: {
            fill: { kind: 'solid', color: { kind: 'srgb', value: '#00ff00' } },
            stroke: { width: 2, fill: { kind: 'srgb', value: '#ff0000' } },
          },
        },
      ],
      animations: [],
    };
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();

    const arrow = container.querySelector<HTMLElement>('[data-native-v2-element-id="arrow"]');
    // SVG 路径承担填充描边，宿主盒子不再画 CSS 背景。
    expect(arrow?.style.background).toBe('');
    const arrowPath = arrow?.querySelector('svg[data-native-v2-preset-geometry] path');
    expect(arrowPath?.getAttribute('d')).toBe(
      'M 0 25 L 150 25 L 150 0 L 200 50 L 150 100 L 150 75 L 0 75 Z',
    );
    expect(arrowPath?.getAttribute('fill')).toBe('#00ff00');
    expect(arrowPath?.getAttribute('stroke')).toBe('#ff0000');
    expect(arrowPath?.getAttribute('stroke-width')).toBe('2');

    const diamondPath = container.querySelector(
      '[data-native-v2-element-id="diamond"] svg[data-native-v2-preset-geometry] path',
    );
    expect(diamondPath?.getAttribute('d')).toBe('M 100 0 L 200 50 L 100 100 L 0 50 Z');
    expect(diamondPath?.getAttribute('fill')).toBe('#123456');

    // 花括号是开放描边路径：不吃填充，只描边。
    const bracePath = container.querySelector(
      '[data-native-v2-element-id="brace"] svg[data-native-v2-preset-geometry] path',
    );
    expect(bracePath?.getAttribute('fill')).toBe('none');
    expect(bracePath?.getAttribute('stroke')).toBe('#ff0000');
  });

  it('renders shadow and glow effects via box-shadow and SVG drop-shadow filters', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'effects-slide',
      title: 'Effects slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'shadow-rect',
          type: 'shape',
          transform,
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: {
            fill: { kind: 'solid', color },
            effects: {
              // angle 0 = 正东：dx=3、dy=0。
              shadow: {
                color: { kind: 'srgb', value: '#000000', alpha: 0.5 },
                blur: 4,
                distance: 3,
                angle: 0,
              },
              glow: { color: { kind: 'srgb', value: '#ffcc00' }, radius: 8 },
            },
          },
        },
        {
          id: 'shadow-arrow',
          type: 'shape',
          transform: { ...transform, y: 140 },
          zIndex: 2,
          geometry: { kind: 'preset', preset: 'rightArrow' },
          style: {
            fill: { kind: 'solid', color },
            effects: {
              // angle 90 = 正南（顺时针、屏幕 y 向下）：dx=0、dy=5。
              shadow: {
                color: { kind: 'srgb', value: '#112233' },
                blur: 2,
                distance: 5,
                angle: 90,
              },
            },
          },
        },
        {
          id: 'glow-group',
          type: 'group',
          transform: { x: 400, y: 20, width: 200, height: 100 },
          zIndex: 3,
          effects: { glow: { color: { kind: 'srgb', value: '#00ffff' }, radius: 6 } },
          children: [
            {
              id: 'group-child',
              type: 'shape',
              transform: { x: 0, y: 0, width: 80, height: 60 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'solid', color } },
            },
          ],
        },
      ],
      animations: [],
    };
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    // 效果原生渲染：不落诊断占位，也没有诊断面板。
    expect(container.querySelector('[data-native-v2-unsupported-element]')).toBeNull();
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();

    const shadowRect = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="shadow-rect"]',
    );
    expect(shadowRect?.style.boxShadow).toContain('3px 0px 4px rgba(0, 0, 0, 0.5)');
    // 光晕双层：radius 与 2×radius。
    expect(shadowRect?.style.boxShadow).toContain('0 0 8px #ffcc00');
    expect(shadowRect?.style.boxShadow).toContain('0 0 16px #ffcc00');

    const arrowSvg = container.querySelector<SVGSVGElement>(
      '[data-native-v2-element-id="shadow-arrow"] svg[data-native-v2-preset-geometry]',
    );
    expect(arrowSvg?.style.filter).toContain('drop-shadow(0px 5px 2px #112233)');

    const group = container.querySelector<HTMLElement>('[data-native-v2-element-id="glow-group"]');
    expect(group?.style.filter).toContain('drop-shadow(0 0 6px #00ffff)');
  });

  it('renders stretch-fit cropped images by oversizing inside a clipping box', () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'cropped-slide',
      title: 'Cropped image slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'cropped',
          type: 'image',
          transform,
          zIndex: 1,
          resourceId: 'image-resource',
          fit: 'stretch',
          crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
          alt: 'Cropped image',
        },
      ],
      animations: [],
    };
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const box = container.querySelector<HTMLElement>('[data-native-v2-element-id="cropped"]');
    expect(box?.style.overflow).toBe('hidden');
    const image = box?.querySelector('img');
    // 可见窗口宽 70%：图片放大到 1/0.7，向左偏移 0.1/0.7。
    expect(Number.parseFloat(image?.style.width ?? '')).toBeCloseTo(142.857, 2);
    expect(Number.parseFloat(image?.style.left ?? '')).toBeCloseTo(-14.286, 2);
    expect(Number.parseFloat(image?.style.height ?? '')).toBeCloseTo(100, 5);
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
  });

  it('keeps ordinary GIF crop rendering and only controls trusted generated GIFs', async () => {
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'gif-slide',
      title: 'GIF slide',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'gif',
          type: 'image',
          transform,
          zIndex: 1,
          resourceId: 'gif-resource',
          fit: 'stretch',
          crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
          alt: 'Animated image',
        },
      ],
      animations: [],
    };
    const render = async (trustedAnimatedGifResourceIds?: ReadonlySet<string>) =>
      await act(async () =>
        root.render(
          <NativeV2SlideRenderer
            resourceMimeTypesById={{ 'gif-resource': 'image/gif' }}
            resourceUrlsById={{ 'gif-resource': '/motion.gif' }}
            trustedAnimatedGifResourceIds={trustedAnimatedGifResourceIds}
            slide={slide}
            stage={{ width: 800, height: 450 }}
          />,
        ),
      );
    await render();
    expect(container.querySelector('[data-gif-state]')).toBeNull();
    expect(container.querySelector('img')?.style.width).toBe('142.85714285714286%');
    // Keep the byte fetch pending so the controlled canvas path (not the native fallback) is asserted.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    try {
      await render(new Set(['gif-resource']));
      expect(container.querySelector('[data-gif-state]')).not.toBeNull();
      expect(container.querySelector('[data-gif-state] canvas')).not.toBeNull();
      expect(container.querySelector('img')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows an unresolved-resource diagnostic instead of a broken image fallback', () => {
    const slide = supportedSlide();
    slide.elements = slide.elements.filter((element) => element.id === 'group');
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          resourceUrlsById={{}}
          slide={slide}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-diagnostic-code="UNRESOLVED_RESOURCE"]')).not.toBeNull();
    expect(container.textContent).toContain('has no explicit display URL');
  });

  it('selects supported native elements without making diagnostic fallbacks editable', () => {
    const onElementSelect = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementSelect={onElementSelect}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          selectedElementId="rectangle"
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const rectangle = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="rectangle"]',
    );
    expect(rectangle?.style.outline).toBe('3px solid #2563eb');
    act(() => rectangle?.click());
    expect(onElementSelect).toHaveBeenLastCalledWith('rectangle');

    const stage = container.querySelector<HTMLElement>('[data-native-v2-stage]');
    act(() => stage?.click());
    expect(onElementSelect).toHaveBeenLastCalledWith(undefined);
  });

  it('renders a transform overlay with resize/rotate handles and keyboard nudging', () => {
    const onElementTransformChange = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementTransformChange={onElementTransformChange}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          selectedElementId="rectangle"
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const overlay = container.querySelector<HTMLElement>(
      '[data-native-v2-transform-overlay="rectangle"]',
    );
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll('[data-resize-corner]')).toHaveLength(4);
    expect(overlay?.querySelector('[data-rotate-handle]')).not.toBeNull();

    act(() => {
      overlay?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onElementTransformChange).toHaveBeenLastCalledWith('rectangle', {
      x: 20,
      y: 20,
      width: 200,
      height: 100,
    });
  });

  it('snaps a dragged element to a neighbour edge and shows the alignment guide', () => {
    const onElementTransformChange = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementTransformChange={onElementTransformChange}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          selectedElementId="rectangle"
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const overlay = container.querySelector<HTMLElement>(
      '[data-native-v2-transform-overlay="rectangle"]',
    );
    act(() => {
      overlay?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }),
      );
      // 矩形右缘 210→217，距椭圆左缘 220 仅 3px（阈值内）：x 应吸附到 20。
      window.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 107, clientY: 110 }),
      );
    });
    expect(onElementTransformChange).toHaveBeenLastCalledWith('rectangle', {
      x: 20,
      y: 30,
      width: 200,
      height: 100,
    });
    expect(container.querySelector('[data-deck-align-guide="vertical"]')).not.toBeNull();
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
    expect(container.querySelector('[data-deck-align-guide="vertical"]')).toBeNull();
  });

  it('snaps rotation to the vertical axis and shows the centre guide', () => {
    const onElementTransformChange = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementTransformChange={onElementTransformChange}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          selectedElementId="rectangle"
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const handle = container.querySelector<HTMLElement>('[data-rotate-handle]');
    act(() => {
      // 元素中心 (110, 70)：起点在正上方（-90°），移到右侧略偏下（约 +2°），
      // 原始增量 ≈ 92° —— 应吸附到 90 并显示过中心的竖直参考线。
      handle?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 110, clientY: -30 }),
      );
      window.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 210, clientY: 74 }),
      );
    });
    expect(onElementTransformChange).toHaveBeenLastCalledWith(
      'rectangle',
      expect.objectContaining({ rotation: 90 }),
    );
    expect(container.querySelector('[data-deck-align-guide="vertical"]')).not.toBeNull();
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
    expect(container.querySelector('[data-deck-align-guide="vertical"]')).toBeNull();
  });

  it('keeps lines and groups move-only in the transform overlay', () => {
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementTransformChange={vi.fn()}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          selectedElementId="line"
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const overlay = container.querySelector<HTMLElement>(
      '[data-native-v2-transform-overlay="line"]',
    );
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll('[data-resize-corner]')).toHaveLength(0);
    expect(overlay?.querySelector('[data-rotate-handle]')).toBeNull();
  });

  it('starts inline text editing on overlay double-click and swaps in the host editor', () => {
    const onTextFrameDoubleClick = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onElementTransformChange={vi.fn()}
          onTextFrameDoubleClick={onTextFrameDoubleClick}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          selectedElementId="text"
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );

    const overlay = container.querySelector<HTMLElement>('[data-native-v2-transform-overlay]');
    act(() => {
      overlay?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onTextFrameDoubleClick).toHaveBeenCalledWith('text');

    act(() =>
      root.render(
        <NativeV2SlideRenderer
          editingElementId="text"
          onElementTransformChange={vi.fn()}
          renderEditingTextFrame={(element) => (
            <textarea data-testid="inline-editor" defaultValue={element.id} />
          )}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          selectedElementId="text"
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    // 编辑中：浮层让位给行内编辑器，静态富文本被宿主编辑器替换。
    expect(container.querySelector('[data-native-v2-transform-overlay]')).toBeNull();
    const editing = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="text"] [data-testid="inline-editor"]',
    );
    expect(editing).not.toBeNull();
    expect(container.querySelector('[data-native-v2-element-id="text"] ul li')).toBeNull();
  });

  it('reports scaled stage coordinates only when the blank canvas is double-clicked', () => {
    const onBlankCanvasDoubleClick = vi.fn();
    act(() =>
      root.render(
        <NativeV2SlideRenderer
          onBlankCanvasDoubleClick={onBlankCanvasDoubleClick}
          resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
          slide={supportedSlide()}
          stage={{ width: 800, height: 450 }}
        />,
      ),
    );
    const viewport = container.querySelector<HTMLElement>('[data-native-v2-viewport]');
    const stage = container.querySelector<HTMLElement>('[data-native-v2-stage]');
    const element = container.querySelector<HTMLElement>('[data-native-v2-element-id="rectangle"]');
    if (viewport === null || stage === null || element === null) {
      throw new Error('Expected native viewport, stage, and element.');
    }
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 400 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          bottom: 245,
          height: 225,
          left: 10,
          right: 410,
          top: 20,
          width: 400,
          x: 10,
          y: 20,
          toJSON: () => ({}),
        }),
      },
    });

    act(() =>
      stage.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 210, clientY: 120 }),
      ),
    );
    expect(onBlankCanvasDoubleClick).toHaveBeenCalledWith({ x: 400, y: 200 });

    act(() =>
      element.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 30, clientY: 40 }),
      ),
    );
    expect(onBlankCanvasDoubleClick).toHaveBeenCalledTimes(1);
  });

  describe('动画运行时（currentTime 驱动）', () => {
    const animatedSlide = (): ReachDeckNativeSlideV2 => ({
      ...supportedSlide(),
      animations: [
        {
          id: 'rectangle-entrance',
          targetId: 'rectangle',
          trigger: 'on-enter',
          effect: 'fade',
          start: 2,
          duration: 0.4,
          easing: 'ease-out',
          from: { opacity: 0, translateY: 24 },
          to: { opacity: 1, translateY: 0 },
        },
      ],
    });

    const renderAt = (currentTime?: number) =>
      act(() =>
        root.render(
          <NativeV2SlideRenderer
            resourceUrlsById={{ 'image-resource': 'https://assets.example.test/image.png' }}
            slide={animatedSlide()}
            stage={{ width: 800, height: 450 }}
            {...(currentTime === undefined ? {} : { currentTime })}
          />,
        ),
      );

    it('入场动画开始前元素隐藏（讲到才出现）', () => {
      renderAt(0);
      const rectangle = container.querySelector<HTMLElement>(
        '[data-native-v2-element-id="rectangle"]',
      );
      expect(rectangle?.style.opacity).toBe('0');
      expect(rectangle?.style.visibility).toBe('hidden');
      // 无动画的元素不受影响。
      const ellipse = container.querySelector<HTMLElement>('[data-native-v2-element-id="ellipse"]');
      expect(ellipse?.style.visibility).not.toBe('hidden');
    });

    it('动画结束后停在终态：完全可见且位移归零', () => {
      renderAt(5);
      const rectangle = container.querySelector<HTMLElement>(
        '[data-native-v2-element-id="rectangle"]',
      );
      expect(rectangle?.style.opacity).toBe('1');
      expect(rectangle?.style.transform ?? '').not.toContain('translateY');
    });

    it('动画进行中透明度与位移处于中间值', () => {
      renderAt(2.2);
      const rectangle = container.querySelector<HTMLElement>(
        '[data-native-v2-element-id="rectangle"]',
      );
      const opacity = Number(rectangle?.style.opacity);
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
      expect(rectangle?.style.transform).toContain('translateY(');
    });

    it('不传 currentTime 时保持静态终态渲染（编辑器画布 / 缩略图）', () => {
      renderAt(undefined);
      const rectangle = container.querySelector<HTMLElement>(
        '[data-native-v2-element-id="rectangle"]',
      );
      expect(rectangle?.style.visibility).not.toBe('hidden');
      expect(rectangle?.style.opacity).toBe('1');
    });

    it('入场动画不再产生 UNSUPPORTED_ANIMATION 诊断', () => {
      renderAt(0);
      expect(
        container.querySelector('[data-native-v2-diagnostics]')?.textContent ?? '',
      ).not.toContain('Animation fade');
    });
  });
});
