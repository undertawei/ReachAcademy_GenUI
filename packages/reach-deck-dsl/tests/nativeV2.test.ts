import { describe, expect, it } from 'vitest';

import {
  analyzeReachDeckNativeSlideV2Capabilities,
  isReachScientificAnchorBindingSetUsable,
  isReachDeckNativeSlideV2,
  parseReachDeckNativeSlideV2,
  reachDeckOrphanAnimationIds,
  type ReachDeckNativeSlideV2,
  type ReachDeckNativeV2Feature,
  type ReachDeckTextFrameV2,
  type RichTextNode,
} from '../src/index.js';
import {
  scientificNativeElementFixture,
  scientificNativeSlideFixture,
} from './scientificVisualFixtures.js';

const color = { kind: 'srgb' as const, value: '#112233' };
const transform = { x: 10, y: 20, width: 200, height: 100 };

const paragraph = (list = false): RichTextNode => {
  const node: RichTextNode = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: 'Editable text',
        marks: [
          { type: 'bold' },
          {
            type: 'textStyle',
            attrs: { fontFamily: 'Aptos', fontSize: '24px', color: '#112233' },
          },
        ],
      },
    ],
  };
  return list ? { type: 'bulletList', content: [{ type: 'listItem', content: [node] }] } : node;
};

const textFrame = (
  _id: string,
  options: { list?: boolean; substituted?: boolean } = {},
): ReachDeckTextFrameV2 => ({
  margins: { left: 8, top: 4, right: 8, bottom: 4 },
  verticalAlignment: 'middle',
  wrap: true,
  autofit: { mode: 'shrink-text', fontScale: 0.9, lineSpacingReduction: 0.05 },
  doc: { type: 'doc', content: [paragraph(options.list)] },
  fontSubstitutions: options.substituted
    ? [
        {
          requestedFamily: 'Missing Font',
          resolvedFamily: 'Noto Sans',
          reason: 'configured-substitute',
          metricsDigest: 'sha256:metrics',
        },
      ]
    : [],
});

const broadSlide = (): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'slide-1',
  title: 'Native v2',
  layoutId: 'layout-1',
  background: { kind: 'solid', color },
  elements: [
    {
      id: 'shape-1',
      type: 'shape',
      transform,
      zIndex: 1,
      geometry: { kind: 'preset', preset: 'roundRect', adjustments: { radius: 0.25 } },
      style: {
        fill: {
          kind: 'gradient',
          angle: 90,
          stops: [
            { offset: 0, color },
            { offset: 1, color: { kind: 'theme', token: 'accent', tint: 0.2 } },
          ],
        },
        stroke: { width: 2, fill: color, dash: 'dash', cap: 'round', join: 'round' },
        effects: { shadow: { color, blur: 4, distance: 3, angle: 45 } },
      },
      text: textFrame('shape-text'),
      source: { partPath: 'ppt/slides/slide1.xml', sourceId: '2' },
    },
    {
      id: 'text-1',
      type: 'textFrame',
      transform: { ...transform, x: 240 },
      zIndex: 2,
      text: textFrame('text', { list: true, substituted: true }),
    },
    {
      id: 'line-1',
      type: 'line',
      transform: { ...transform, height: 1 },
      zIndex: 3,
      start: { x: 0, y: 0, connection: { elementId: 'shape-1', site: 0 } },
      end: { x: 200, y: 0, marker: 'arrow', connection: { elementId: 'text-1', site: 1 } },
      routing: 'straight',
      connector: true,
      stroke: { width: 1, fill: color },
    },
    {
      id: 'group-1',
      type: 'group',
      transform: { ...transform, x: 460 },
      zIndex: 4,
      // 组级效果：来自 grpSpPr effectLst 的降级映射目标。
      effects: { shadow: { color, blur: 2, distance: 1, angle: 90 } },
      children: [
        {
          id: 'custom-shape-1',
          type: 'shape',
          transform: { x: 0, y: 0, width: 50, height: 50 },
          zIndex: 1,
          geometry: {
            kind: 'custom',
            viewBox: { width: 100, height: 100 },
            path: 'M0 0 L100 100 Z',
            // 描边细节线与填充面分属不同子路径(OOXML a:path@fill/@stroke)。
            subpaths: [
              { path: 'M0 0 L100 100 Z', stroked: false },
              { path: 'M0 100 L100 0', fillMode: 'none' },
            ],
          },
          style: { fill: { kind: 'image', resourceId: 'media-fill', mode: 'tile' } },
        },
      ],
    },
    {
      id: 'image-1',
      type: 'image',
      transform: { ...transform, y: 140 },
      zIndex: 5,
      resourceId: 'image-resource',
      fit: 'contain',
      crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 },
      alt: 'Source image',
      effects: { glow: { color, radius: 5 } },
    },
    {
      id: 'audio-1',
      type: 'audio',
      transform: { ...transform, y: 260 },
      zIndex: 6,
      resourceId: 'audio-resource',
      playback: { startAt: 0, endAt: 4, autoplay: false, loop: false, volume: 0.8 },
      title: 'Narration',
    },
    {
      id: 'video-1',
      type: 'video',
      transform: { ...transform, x: 220, y: 260 },
      zIndex: 7,
      resourceId: 'video-resource',
      posterResourceId: 'poster-resource',
      playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
      title: 'Video',
    },
    {
      id: 'table-1',
      type: 'table',
      transform: { ...transform, x: 440, y: 260 },
      zIndex: 8,
      columnWidths: [200],
      rowHeights: [100],
      rows: [
        {
          id: 'row-1',
          cells: [
            {
              id: 'cell-1',
              rowSpan: 1,
              columnSpan: 1,
              text: textFrame('cell-text'),
              style: {
                fill: { kind: 'pattern', preset: 'pct10', foreground: color, background: color },
              },
            },
          ],
        },
      ],
    },
    {
      id: 'chart-1',
      type: 'chart',
      transform: { ...transform, y: 380 },
      zIndex: 9,
      chartType: 'column',
      categories: ['A'],
      series: [{ id: 'series-1', name: 'Series', values: [1], color }],
      showLegend: true,
      showDataLabels: false,
    },
    {
      id: 'unsupported-chart',
      type: 'chart',
      transform: { x: 100, y: 100, width: 320, height: 180 },
      zIndex: 9,
      chartType: 'unsupported',
      sourceChartType: 'radarChart',
      showLegend: false,
      showDataLabels: false,
    },
    {
      id: 'formula-1',
      type: 'formula',
      transform: { ...transform, x: 220, y: 380 },
      zIndex: 10,
      latex: 'x^2 + y^2',
      display: 'block',
      color,
    },
    {
      id: 'diagram-1',
      type: 'diagram',
      transform: { ...transform, x: 440, y: 380 },
      zIndex: 11,
      diagramType: 'process',
      nodes: [
        {
          id: 'node-a',
          label: textFrame('node-a-text'),
          style: { fill: { kind: 'solid', color } },
        },
        { id: 'node-b', label: textFrame('node-b-text'), style: {} },
      ],
      edges: [{ id: 'edge-a-b', from: 'node-a', to: 'node-b' }],
    },
  ],
  notes: { doc: { type: 'doc', content: [paragraph()] } },
  transition: { type: 'wipe', duration: 0.5, direction: 'left', advanceAfter: 5 },
  animations: [
    {
      id: 'animation-1',
      targetId: 'chart-1',
      trigger: 'on-enter',
      effect: 'fade',
      start: 0,
      duration: 0.5,
      easing: 'ease-out',
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
  ],
});

describe('Reach Deck native v2 contract', () => {
  it('strictly parses the broad additive editable model without rewriting it', () => {
    const slide = broadSlide();
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    expect(isReachDeckNativeSlideV2(slide)).toBe(true);
  });

  it('accepts legacy color animations but strictly validates present color endpoints', () => {
    const legacy = broadSlide();
    legacy.animations = [
      {
        id: 'color-legacy',
        targetId: 'text-1',
        trigger: 'on-enter',
        effect: 'color',
        start: 0,
        duration: 1,
      },
    ];
    expect(parseReachDeckNativeSlideV2(legacy)).toBe(legacy);

    const valid = structuredClone(legacy);
    valid.animations[0]!.from = { color: '#172024' };
    valid.animations[0]!.to = { color: '#2563EB' };
    expect(parseReachDeckNativeSlideV2(valid)).toBe(valid);

    const lowercase = structuredClone(valid);
    lowercase.animations[0]!.to = { color: '#2563eb' };
    expect(() => parseReachDeckNativeSlideV2(lowercase)).toThrow(/uppercase #RRGGBB/i);

    const wrongKey = structuredClone(valid);
    wrongKey.animations[0]!.from = { fill: '#172024' };
    expect(() => parseReachDeckNativeSlideV2(wrongKey)).toThrow(/required fields: color/i);
  });

  it('accepts additive native/PPTX text compatibility while preserving missing-field history', () => {
    const historical = broadSlide();
    expect(parseReachDeckNativeSlideV2(historical)).toBe(historical);
    for (const textCompatibility of ['native', 'pptx'] as const) {
      const slide = { ...broadSlide(), textCompatibility };
      expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    }
    expect(() =>
      parseReachDeckNativeSlideV2({ ...broadSlide(), textCompatibility: 'unknown' }),
    ).toThrow(/textCompatibility is invalid/i);
  });

  it('rejects unknown fields and duplicate nested element ids but keeps orphan animations', () => {
    const withUnknown = { ...broadSlide(), silentlyIgnored: true };
    expect(() => parseReachDeckNativeSlideV2(withUnknown)).toThrow(/unsupported fields/i);

    // 目标元素已删除的孤儿动画不阻断解析：保存、渲染照常，播放时忽略、时间轴标红。
    const orphanAnimation = broadSlide();
    orphanAnimation.animations[0].targetId = 'missing';
    expect(parseReachDeckNativeSlideV2(orphanAnimation)).toBe(orphanAnimation);
    expect(reachDeckOrphanAnimationIds(orphanAnimation)).toEqual(
      new Set([orphanAnimation.animations[0].id]),
    );
    expect(reachDeckOrphanAnimationIds(broadSlide())).toEqual(new Set());

    const duplicate = broadSlide();
    if (duplicate.elements[3].type !== 'group') throw new Error('Expected group fixture.');
    duplicate.elements[3].children[0].id = 'shape-1';
    expect(() => parseReachDeckNativeSlideV2(duplicate)).toThrow(/element ids must be unique/i);
  });

  it('accepts image fill insets, negative crop bleed, and image strokes within bounds', () => {
    const slide = broadSlide();
    if (slide.elements[0].type !== 'shape') throw new Error('Expected shape fixture.');
    // PPT stretch fillRect 负偏移 = 图片向外出血,填充盒裁剪。
    slide.elements[0].style.fill = {
      kind: 'image',
      resourceId: 'media-fill',
      mode: 'stretch',
      insets: { left: -0.034, top: -1.655, right: 0, bottom: -2.524 },
    };
    const image = slide.elements.find((element) => element.type === 'image');
    if (image?.type !== 'image') throw new Error('Expected image fixture.');
    // 负值 srcRect = 图片内嵌缩小,边缘留空。
    image.crop = { left: -0.1, top: 0, right: 0.2, bottom: -0.05 };
    image.stroke = { width: 1.5, fill: { kind: 'srgb', value: '#123456' }, dash: 'dash' };
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);

    const coveredInsets = broadSlide();
    if (coveredInsets.elements[0].type !== 'shape') throw new Error('Expected shape fixture.');
    coveredInsets.elements[0].style.fill = {
      kind: 'image',
      resourceId: 'media-fill',
      mode: 'stretch',
      insets: { left: 0.6, top: 0, right: 0.6, bottom: 0 },
    };
    expect(() => parseReachDeckNativeSlideV2(coveredInsets)).toThrow(/insets/i);

    const tiledInsets = broadSlide();
    if (tiledInsets.elements[0].type !== 'shape') throw new Error('Expected shape fixture.');
    tiledInsets.elements[0].style.fill = {
      kind: 'image',
      resourceId: 'media-fill',
      mode: 'tile',
      insets: { left: -0.1, top: 0, right: 0, bottom: 0 },
    };
    expect(() => parseReachDeckNativeSlideV2(tiledInsets)).toThrow(/stretch/i);

    // MAIC 常见的两倍多高裁剪窗口(range 底边 226.8% → bottom = -1.268)必须收下。
    const deepBleed = broadSlide();
    const deepBleedImage = deepBleed.elements.find((element) => element.type === 'image');
    if (deepBleedImage?.type !== 'image') throw new Error('Expected image fixture.');
    deepBleedImage.crop = { left: 0, top: 0, right: 0.6199, bottom: -1.268 };
    expect(() => parseReachDeckNativeSlideV2(deepBleed)).not.toThrow();

    const overCrop = broadSlide();
    const overCropImage = overCrop.elements.find((element) => element.type === 'image');
    if (overCropImage?.type !== 'image') throw new Error('Expected image fixture.');
    overCropImage.crop = { left: -10.5, top: 0, right: 0, bottom: 0 };
    expect(() => parseReachDeckNativeSlideV2(overCrop)).toThrow(/crop/i);
  });

  it('rejects custom geometry subpaths without a path or with an unknown fill mode', () => {
    const customGeometry = (slide: ReachDeckNativeSlideV2): { subpaths?: unknown } => {
      const group = slide.elements.find((element) => element.type === 'group');
      const shape = group?.type === 'group' ? group.children[0] : undefined;
      if (shape?.type !== 'shape' || shape.geometry.kind !== 'custom') {
        throw new Error('Expected custom geometry fixture.');
      }
      return shape.geometry as { subpaths?: unknown };
    };

    const empty = broadSlide();
    customGeometry(empty).subpaths = [];
    expect(() => parseReachDeckNativeSlideV2(empty)).toThrow(/subpaths must not be empty/i);

    const missingPath = broadSlide();
    customGeometry(missingPath).subpaths = [{ stroked: false }];
    expect(() => parseReachDeckNativeSlideV2(missingPath)).toThrow(/required fields: path/i);

    const unknownFill = broadSlide();
    customGeometry(unknownFill).subpaths = [{ path: 'M0 0 L1 1', fillMode: 'darken' }];
    expect(() => parseReachDeckNativeSlideV2(unknownFill)).toThrow(/fillMode is unsupported/i);
  });

  it('accepts elbow line bends only on elbow routing and within [0, 1]', () => {
    const slide = broadSlide();
    const line = slide.elements.find((element) => element.type === 'line');
    if (line?.type !== 'line') throw new Error('Expected line fixture.');
    // bentConnector3 adj1=626 → 竖直段位于水平行程 0.626% 处。
    line.routing = 'elbow';
    line.bend = 0.00626;
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);

    const straightBend = broadSlide();
    const straightLine = straightBend.elements.find((element) => element.type === 'line');
    if (straightLine?.type !== 'line') throw new Error('Expected line fixture.');
    straightLine.bend = 0.5;
    expect(() => parseReachDeckNativeSlideV2(straightBend)).toThrow(/elbow/i);

    const outOfRange = broadSlide();
    const outOfRangeLine = outOfRange.elements.find((element) => element.type === 'line');
    if (outOfRangeLine?.type !== 'line') throw new Error('Expected line fixture.');
    outOfRangeLine.routing = 'elbow';
    outOfRangeLine.bend = 1.2;
    expect(() => parseReachDeckNativeSlideV2(outOfRange)).toThrow(/bend/i);
  });

  it('bounds recursive group validation before traversing an unsafe depth', () => {
    let nested: ReachDeckNativeSlideV2['elements'][number] = {
      id: 'leaf',
      type: 'shape',
      transform,
      zIndex: 1,
      geometry: { kind: 'preset', preset: 'rect' },
      style: {},
    };
    for (let depth = 0; depth < 34; depth += 1) {
      nested = {
        id: `group-${depth}`,
        type: 'group',
        transform,
        zIndex: depth,
        children: [nested],
      };
    }
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      id: 'nested',
      title: 'Nested',
      background: { kind: 'none' },
      elements: [nested],
      animations: [],
    };

    expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/group nesting exceeds/i);
  });

  it('uses honest point contracts for scatter and bubble charts', () => {
    const scatter = broadSlide();
    const chartIndex = scatter.elements.findIndex((element) => element.type === 'chart');
    const chartBase = scatter.elements[chartIndex];
    if (chartBase?.type !== 'chart') throw new Error('Expected chart fixture.');
    scatter.elements[chartIndex] = {
      ...chartBase,
      chartType: 'scatter',
      series: [{ id: 'scatter-series', name: 'Scatter', points: [{ x: 1, y: 2 }] }],
    };
    delete (scatter.elements[chartIndex] as { categories?: unknown }).categories;
    expect(parseReachDeckNativeSlideV2(scatter)).toBe(scatter);

    const bubble = structuredClone(scatter);
    const bubbleChart = bubble.elements[chartIndex];
    if (bubbleChart?.type !== 'chart') throw new Error('Expected chart fixture.');
    bubble.elements[chartIndex] = {
      ...bubbleChart,
      chartType: 'bubble',
      series: [{ id: 'bubble-series', name: 'Bubble', points: [{ x: 1, y: 2, size: 3 }] }],
    };
    expect(parseReachDeckNativeSlideV2(bubble)).toBe(bubble);

    const invalidBubble = structuredClone(bubble);
    const invalidChart = invalidBubble.elements[chartIndex];
    if (invalidChart?.type !== 'chart' || invalidChart.chartType !== 'bubble') {
      throw new Error('Expected bubble chart fixture.');
    }
    invalidChart.series[0].points[0].size = 0;
    expect(() => parseReachDeckNativeSlideV2(invalidBubble)).toThrow(/size must be positive/i);
  });

  it('keeps schema representation separate from explicit consumer support', () => {
    const slide = broadSlide();
    const unsupported = analyzeReachDeckNativeSlideV2Capabilities(slide, {
      consumer: 'test-renderer',
      version: '0.1.0',
      supportedFeatures: new Set(),
    });
    expect(unsupported.compatible).toBe(false);
    expect(unsupported.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: 'chart', severity: 'error' }),
        expect.objectContaining({ feature: 'formula', severity: 'error' }),
        expect.objectContaining({ feature: 'diagram', severity: 'error' }),
        expect.objectContaining({ feature: 'text.font-substitution', severity: 'error' }),
      ]),
    );

    const declared = analyzeReachDeckNativeSlideV2Capabilities(slide, {
      consumer: 'complete-test-consumer',
      version: '1.0.0',
      supportedFeatures: new Set<ReachDeckNativeV2Feature>(unsupported.requiredFeatures),
    });
    expect(declared).toMatchObject({ compatible: true, diagnostics: [] });
  });

  describe('narration and duration', () => {
    it('accepts a slide with duration and a fully timestamped narration', () => {
      const slide = broadSlide();
      slide.duration = 12.5;
      slide.narration = {
        audioResourceId: 'audio-narration',
        segments: [
          { text: 'Segment one.', start: 0, end: 4 },
          { text: 'Segment two.', start: 4, end: 9.5 },
        ],
      };
      expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    });

    it('accepts narration segments before TTS timestamp resolution and without an audio resource', () => {
      const slide = broadSlide();
      slide.narration = {
        segments: [{ text: 'Draft narration, not yet synthesized.' }],
      };
      expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    });

    it('accepts the three narration compatibility states', () => {
      const legacy = broadSlide();
      legacy.narration = { segments: [{ text: 'Legacy.' }] };
      expect(parseReachDeckNativeSlideV2(legacy)).toBe(legacy);

      const invalidated = broadSlide();
      invalidated.narration = { markdown: '教师讲稿' };
      expect(parseReachDeckNativeSlideV2(invalidated)).toBe(invalidated);

      const generated = broadSlide();
      generated.narration = {
        markdown: '教师讲稿',
        audioResourceId: 'audio-narration',
        segments: [{ text: '教师讲稿', start: 0, end: 2 }],
      };
      expect(parseReachDeckNativeSlideV2(generated)).toBe(generated);
    });

    it('rejects mixed authoritative content and old or incomplete derived state', () => {
      const cases = [
        { markdown: '新讲稿', segments: [{ text: '旧字幕', start: 0, end: 1 }] },
        { markdown: '新讲稿', audioResourceId: 'old-audio' },
        {
          markdown: '新讲稿',
          audioResourceId: 'audio',
          segments: [{ text: '字幕无时间' }],
        },
      ];
      cases.forEach((narration, index) => {
        const slide = broadSlide();
        slide.narration = narration;
        expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(
          index === 2 ? /fully timed/i : /authoritative/i,
        );
      });
    });

    it('rejects a non-positive or non-finite duration', () => {
      const zero = broadSlide();
      zero.duration = 0;
      expect(() => parseReachDeckNativeSlideV2(zero)).toThrow(/duration must be positive/i);

      const negative = broadSlide();
      negative.duration = -1;
      expect(() => parseReachDeckNativeSlideV2(negative)).toThrow(/duration must be positive/i);

      const infinite = broadSlide();
      infinite.duration = Number.POSITIVE_INFINITY;
      expect(() => parseReachDeckNativeSlideV2(infinite)).toThrow(/duration must be finite/i);
    });

    it('rejects narration with neither content carrier and rejects empty segments', () => {
      const slide = broadSlide();
      slide.narration = { segments: [] };
      expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/segments cannot be empty/i);

      const absent = broadSlide();
      absent.narration = {};
      expect(() => parseReachDeckNativeSlideV2(absent)).toThrow(/legacy segments|authoritative/i);
    });

    it('rejects a narration segment with empty text', () => {
      const slide = broadSlide();
      slide.narration = { segments: [{ text: '   ' }] };
      expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/text must be a non-empty string/i);
    });

    it('rejects a narration segment where only one of start/end is present', () => {
      const startOnly = broadSlide();
      startOnly.narration = { segments: [{ text: 'Segment.', start: 0 }] };
      expect(() => parseReachDeckNativeSlideV2(startOnly)).toThrow(
        /start and end must both be present or both absent/i,
      );

      const endOnly = broadSlide();
      endOnly.narration = { segments: [{ text: 'Segment.', end: 2 }] };
      expect(() => parseReachDeckNativeSlideV2(endOnly)).toThrow(
        /start and end must both be present or both absent/i,
      );
    });

    it('rejects a narration segment whose start is after its end', () => {
      const slide = broadSlide();
      slide.narration = { segments: [{ text: 'Segment.', start: 5, end: 2 }] };
      expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/start must not exceed end/i);
    });

    it('rejects narration segments whose timestamps are out of order', () => {
      const slide = broadSlide();
      slide.narration = {
        segments: [
          { text: 'First.', start: 3, end: 5 },
          { text: 'Second.', start: 1, end: 2 },
        ],
      };
      expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/non-decreasing/i);
    });

    it('allows undated segments to interleave with timestamped ones without breaking ordering', () => {
      const slide = broadSlide();
      slide.narration = {
        segments: [
          { text: 'Timestamped first.', start: 0, end: 2 },
          { text: 'Not yet timestamped.' },
          { text: 'Timestamped second.', start: 2, end: 4 },
        ],
      };
      expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    });

    it('rejects an empty audioResourceId', () => {
      const slide = broadSlide();
      slide.narration = { audioResourceId: '  ', segments: [{ text: 'Segment.' }] };
      expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(
        /audioResourceId must be a non-empty string/i,
      );
    });

    it('accepts word-level timestamps on a narration segment', () => {
      const slide = broadSlide();
      slide.narration = {
        segments: [
          {
            text: '你好，世界',
            start: 0,
            end: 1.2,
            words: [
              { text: '你', start: 0, end: 0.3 },
              { text: '好，', start: 0.3, end: 0.7 },
              { text: '世界', start: 0.7, end: 1.2 },
            ],
          },
        ],
      };
      expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    });

    it('rejects narration words that are out of order or malformed', () => {
      const outOfOrder = broadSlide();
      outOfOrder.narration = {
        segments: [
          {
            text: 'AB',
            start: 0,
            end: 1,
            words: [
              { text: 'B', start: 0.5, end: 1 },
              { text: 'A', start: 0, end: 0.5 },
            ],
          },
        ],
      };
      expect(() => parseReachDeckNativeSlideV2(outOfOrder)).toThrow(/non-decreasing/i);

      const inverted = broadSlide();
      inverted.narration = {
        segments: [{ text: 'A', start: 0, end: 1, words: [{ text: 'A', start: 0.8, end: 0.2 }] }],
      };
      expect(() => parseReachDeckNativeSlideV2(inverted)).toThrow(/start must not exceed end/i);

      const extraKey: unknown = {
        ...broadSlide(),
        narration: {
          segments: [
            {
              text: 'A',
              start: 0,
              end: 1,
              words: [{ text: 'A', start: 0, end: 1, confidence: 0.9 }],
            },
          ],
        },
      };
      expect(() => parseReachDeckNativeSlideV2(extraKey)).toThrow(/confidence/i);
    });
  });
});

describe('Native V2 scientific visual contract', () => {
  it('strictly accepts the top-level element and reports its capability', () => {
    const slide = scientificNativeSlideFixture();
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    const report = analyzeReachDeckNativeSlideV2Capabilities(slide, {
      consumer: 'legacy-renderer',
      version: '1.0.0',
      supportedFeatures: new Set(),
    });
    expect(report.requiredFeatures).toContain('scientific-visual');
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ feature: 'scientific-visual', path: '$.elements[0]' }),
    );
  });

  it('enforces one top-level scientific visual per slide', () => {
    const duplicate = scientificNativeSlideFixture();
    duplicate.elements.push({ ...scientificNativeElementFixture(), id: 'scientific-copy' });
    expect(() => parseReachDeckNativeSlideV2(duplicate)).toThrow(/at most one scientificVisual/i);

    const nested = scientificNativeSlideFixture();
    nested.elements = [
      {
        id: 'group',
        type: 'group',
        transform,
        zIndex: 1,
        children: [scientificNativeElementFixture()],
      },
    ];
    expect(() => parseReachDeckNativeSlideV2(nested)).toThrow(/must be top-level/i);
  });

  it('uses the shared UTF-8 byte ceiling and strict accessibility contract', () => {
    const oversized = scientificNativeSlideFixture();
    const visual = oversized.elements[0];
    if (visual?.type !== 'scientificVisual') throw new Error('Expected scientific visual fixture.');
    visual.documentHtml = '测'.repeat(90_000);
    expect(() => parseReachDeckNativeSlideV2(oversized)).toThrow(/UTF-8 byte limit/i);

    const mismatch = scientificNativeSlideFixture();
    const mismatchedVisual = mismatch.elements[0];
    if (mismatchedVisual?.type !== 'scientificVisual') {
      throw new Error('Expected scientific visual fixture.');
    }
    mismatchedVisual.ariaLabel = '不一致';
    expect(() => parseReachDeckNativeSlideV2(mismatch)).toThrow(/must match manifest/i);
  });

  it('limits whole-element entrances without treating emphasis or exit as another entrance', () => {
    const slide = scientificNativeSlideFixture();
    slide.animations = [
      {
        id: 'entrance',
        targetId: 'scientific-motion',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.5,
      },
      {
        id: 'emphasis',
        targetId: 'scientific-motion',
        trigger: 'on-click',
        effect: 'color',
        start: 2,
        duration: 0.5,
      },
      {
        id: 'exit',
        targetId: 'scientific-motion',
        trigger: 'after-previous',
        effect: 'disappear',
        start: 5,
        duration: 0.5,
      },
    ];
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    slide.animations.push({
      id: 'second-entrance',
      targetId: 'scientific-motion',
      trigger: 'after-previous',
      effect: 'move',
      start: 1,
      duration: 0.5,
    });
    expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/at most one entrance animation/i);
  });

  it('accepts deterministic bindings and exposes exact-set semantic usability', () => {
    const slide = scientificNativeSlideFixture();
    slide.duration = 6;
    slide.narration = {
      audioResourceId: 'narration-audio',
      segments: [{ text: '运动过程', start: 0, end: 6 }],
      scientificAnchorBindings: [
        {
          id: 'narration-anchor:scientific-motion:launch',
          elementId: 'scientific-motion',
          anchorId: 'launch',
          start: 0,
          end: 3,
        },
        {
          id: 'narration-anchor:scientific-motion:arrival',
          elementId: 'scientific-motion',
          anchorId: 'arrival',
          start: 3,
          end: 6,
        },
      ],
    };
    expect(parseReachDeckNativeSlideV2(slide)).toBe(slide);
    expect(isReachScientificAnchorBindingSetUsable(slide)).toBe(true);

    const stale = structuredClone(slide);
    stale.narration!.scientificAnchorBindings = [
      {
        id: 'narration-anchor:scientific-motion:stale',
        elementId: 'scientific-motion',
        anchorId: 'stale',
        start: 0,
        end: 3,
      },
    ];
    expect(parseReachDeckNativeSlideV2(stale)).toBe(stale);
    expect(isReachScientificAnchorBindingSetUsable(stale)).toBe(false);

    const zeroLength = structuredClone(slide);
    zeroLength.narration!.scientificAnchorBindings![0]!.end = 0;
    expect(parseReachDeckNativeSlideV2(zeroLength)).toBe(zeroLength);
    expect(isReachScientificAnchorBindingSetUsable(zeroLength)).toBe(false);
  });

  it('rejects malformed, unordered, out-of-bounds, or invalidated binding records', () => {
    const valid = scientificNativeSlideFixture();
    valid.duration = 6;
    valid.narration = {
      audioResourceId: 'narration-audio',
      segments: [{ text: '运动过程', start: 0, end: 6 }],
      scientificAnchorBindings: [
        {
          id: 'narration-anchor:scientific-motion:arrival',
          elementId: 'scientific-motion',
          anchorId: 'arrival',
          start: 3,
          end: 6,
        },
      ],
    };

    const malformed = structuredClone(valid);
    malformed.narration!.scientificAnchorBindings![0]!.id = 'arbitrary';
    expect(() => parseReachDeckNativeSlideV2(malformed)).toThrow(/does not match/i);

    const outOfBounds = structuredClone(valid);
    outOfBounds.narration!.scientificAnchorBindings![0]!.end = 7;
    expect(() => parseReachDeckNativeSlideV2(outOfBounds)).toThrow(/must not exceed/i);

    const unordered = structuredClone(valid);
    unordered.narration!.scientificAnchorBindings!.unshift({
      id: 'narration-anchor:scientific-motion:launch',
      elementId: 'scientific-motion',
      anchorId: 'launch',
      start: 4,
      end: 5,
    });
    expect(() => parseReachDeckNativeSlideV2(unordered)).toThrow(/non-decreasing/i);

    const invalidated = scientificNativeSlideFixture();
    invalidated.narration = {
      markdown: '待重新生成',
      scientificAnchorBindings: valid.narration.scientificAnchorBindings,
    };
    expect(() => parseReachDeckNativeSlideV2(invalidated)).toThrow(/require generated audio/i);
  });

  it('bounds bindings by timed narration when slide duration is absent', () => {
    const slide = scientificNativeSlideFixture();
    slide.narration = {
      audioResourceId: 'narration-audio',
      segments: [{ text: '运动过程', start: 0, end: 4 }],
      scientificAnchorBindings: [
        {
          id: 'narration-anchor:scientific-motion:launch',
          elementId: 'scientific-motion',
          anchorId: 'launch',
          start: 0,
          end: 5,
        },
      ],
    };
    expect(() => parseReachDeckNativeSlideV2(slide)).toThrow(/must not exceed/i);
  });
});
