import {
  createBlankReachDeckDocument,
  parseReachDeckDocumentV2,
  type ReachDeckNativeElementV2,
  type ReachDeckTextFrameV2,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';
import { fitReachDeckPptxToStage } from '../src/pptx/index.js';

const color = { kind: 'srgb', value: '#123456' } as const;
const base = (id: string) => ({
  id,
  transform: { x: 20, y: 30, width: 100, height: 50 },
  zIndex: 1,
});
const text = (): ReachDeckTextFrameV2 => ({
  margins: { left: 4, right: 6, top: 2, bottom: 8 },
  verticalAlignment: 'middle',
  wrap: true,
  autofit: { mode: 'shrink-text', fontScale: 0.8 },
  fontSubstitutions: [],
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: {
          lineHeight: 1.2,
          lineHeightPx: 24,
          spaceBefore: 6,
          leftIndent: 12,
          firstLineIndent: -3,
        },
        content: [
          {
            type: 'text',
            text: 'Editable',
            marks: [
              {
                type: 'textStyle',
                attrs: { fontSize: '20px', letterSpacing: 2, color: '#123456' },
              },
            ],
          },
        ],
      },
    ],
  },
});
function fixture(elements: ReachDeckNativeElementV2[]) {
  const document = createBlankReachDeckDocument({
    id: 'test',
    title: 'Test',
    generatedAt: '2026-09-28T00:00:00.000Z',
  });
  document.stage = { width: 800, height: 600, aspectRatio: '4:3' };
  document.nativeSlides[0]!.slide.elements = elements;
  return document;
}
const target = { width: 1600, height: 900, aspectRatio: '16:9' } as const;

describe('PPTX editable uniform stage fitting', () => {
  it('centers different ratios, scales physical text/effects and keeps the input immutable', () => {
    const source = fixture([
      {
        ...base('text'),
        type: 'textFrame',
        text: text(),
        style: {
          stroke: { width: 2, fill: color },
          effects: {
            shadow: { color, blur: 4, distance: 6, angle: 30 },
            glow: { color, radius: 2 },
          },
        },
      },
    ]);
    const before = structuredClone(source);
    const result = fitReachDeckPptxToStage(source, target);
    const fitted = result.document.nativeSlides[0]!.slide.elements[1]!;
    expect(fitted).toMatchObject({
      transform: { x: 230, y: 45, width: 150, height: 75 },
      style: {
        stroke: { width: 3 },
        effects: { shadow: { blur: 6, distance: 9, angle: 30 }, glow: { radius: 3 } },
      },
    });
    expect(fitted.type).toBe('textFrame');
    if (fitted.type !== 'textFrame') throw new Error('missing text');
    expect(fitted.text.margins).toEqual({ left: 6, right: 9, top: 3, bottom: 12 });
    expect(fitted.text.autofit.fontScale).toBe(0.8);
    expect(fitted.text.doc.content![0]!.attrs).toMatchObject({
      lineHeight: 1.2,
      lineHeightPx: 36,
      spaceBefore: 9,
      leftIndent: 18,
      firstLineIndent: -4.5,
    });
    expect(fitted.text.doc.content![0]!.content![0]!.marks![0]!.attrs).toMatchObject({
      fontSize: '30px',
      letterSpacing: 3,
    });
    expect(source).toEqual(before);
    expect(parseReachDeckDocumentV2(result.document)).toMatchObject({ stage: target });
    expect(fitReachDeckPptxToStage(source, target)).toEqual(result);
    expect(fitReachDeckPptxToStage(result.document, target).document).toEqual(result.document);
  });

  it('scales nested groups locally and lines including endpoints without doubling the centering offset', () => {
    const source = fixture([
      {
        ...base('group'),
        type: 'group',
        transform: { ...base('x').transform, rotation: 30, flipHorizontal: true },
        children: [
          {
            ...base('nested'),
            type: 'group',
            children: [
              {
                ...base('line'),
                type: 'line',
                start: { x: 0, y: 10, marker: 'arrow', markerSize: 3 },
                end: { x: 100, y: 50 },
                routing: 'elbow',
                bend: 0.5,
                connector: true,
                stroke: { width: 2, fill: color, dash: 'custom', customDash: [4, 2] },
              },
            ],
          },
        ],
      },
    ]);
    const fitted = fitReachDeckPptxToStage(source, target).document.nativeSlides[0]!.slide
      .elements[1]!;
    expect(fitted).toMatchObject({
      transform: { x: 230, y: 45, rotation: 30, flipHorizontal: true },
      children: [
        {
          transform: { x: 30, y: 45 },
          children: [
            {
              transform: { x: 30, y: 45 },
              start: { x: 0, y: 15, markerSize: 3 },
              end: { x: 150, y: 75 },
              bend: 0.5,
              stroke: { width: 3, customDash: [6, 3] },
            },
          ],
        },
      ],
    });
  });

  it('retains custom SVG geometry and scales its non-scaling stroke only once', () => {
    const geometry = {
      kind: 'custom',
      viewBox: { width: 100, height: 50 },
      path: 'M 0 0 L 100 50 Z',
      subpaths: [{ path: 'M 0 0 L 100 50', fillMode: 'none' }],
    } as const;
    const source = fixture([
      { ...base('shape'), type: 'shape', geometry, style: { stroke: { width: 2, fill: color } } },
    ]);
    const result = fitReachDeckPptxToStage(source, target);
    expect(result.document.nativeSlides[0]!.slide.elements[1]).toMatchObject({
      geometry,
      style: { stroke: { width: 3 } },
      transform: { width: 150, height: 75 },
    });
    expect(() => parseReachDeckDocumentV2(result.document)).not.toThrow();
  });

  it('scales tables and media bounds while preserving crops, content and playback', () => {
    const source = fixture([
      {
        ...base('table'),
        type: 'table',
        columnWidths: [40, 60],
        rowHeights: [50],
        rows: [
          {
            id: 'row',
            cells: [1, 2].map((id) => ({
              id: `cell-${id}`,
              rowSpan: 1,
              columnSpan: 1,
              text: text(),
              style: { stroke: { width: 1, fill: color } },
            })),
          },
        ],
      },
      {
        ...base('image'),
        type: 'image',
        resourceId: 'image-resource',
        fit: 'cover',
        alt: 'Image',
        crop: { left: 0.1, right: 0.2, top: 0, bottom: 0 },
        stroke: { width: 2, fill: color },
      },
      {
        ...base('video'),
        type: 'video',
        resourceId: 'video-resource',
        title: 'Video',
        playback: { startAt: 5, endAt: 9, autoplay: false, loop: false, volume: 0.5 },
      },
    ]);
    const elements = fitReachDeckPptxToStage(source, target).document.nativeSlides[0]!.slide
      .elements;
    expect(elements[1]).toMatchObject({
      columnWidths: [60, 90],
      rowHeights: [75],
      rows: [
        { cells: [{ style: { stroke: { width: 1.5 } } }, { style: { stroke: { width: 1.5 } } }] },
      ],
    });
    expect(elements[2]).toMatchObject({
      resourceId: 'image-resource',
      crop: { left: 0.1, right: 0.2 },
      stroke: { width: 3 },
      transform: { width: 150 },
    });
    expect(elements[3]).toMatchObject({
      playback: { startAt: 5, endAt: 9, volume: 0.5 },
      transform: { width: 150 },
    });
  });

  it('contains slide background in fitted content and retains existing z order', () => {
    const source = fixture([
      {
        ...base('shape'),
        zIndex: -3,
        type: 'shape',
        geometry: { kind: 'preset', preset: 'rect' },
        style: {},
      },
    ]);
    source.nativeSlides[0]!.slide.background = {
      kind: 'gradient',
      angle: 30,
      stops: [
        { offset: 0, color },
        { offset: 1, color },
      ],
    };
    const result = fitReachDeckPptxToStage(source, target).document.nativeSlides[0]!.slide;
    expect(result.elements[0]).toMatchObject({
      zIndex: -4,
      transform: { x: 200, y: 0, width: 1200, height: 900 },
      style: { fill: source.nativeSlides[0]!.slide.background },
    });
    expect(result.elements[1]!.zIndex).toBe(-3);
    expect(result.background).toEqual({ kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } });
  });

  it('same-ratio fitting needs no background element and same dimensions are a no-op', () => {
    const source = fixture([
      { ...base('shape'), type: 'shape', geometry: { kind: 'preset', preset: 'rect' }, style: {} },
    ]);
    expect(fitReachDeckPptxToStage(source, source.stage).document).toEqual(source);
    const fit = fitReachDeckPptxToStage(source, { width: 400, height: 300, aspectRatio: '4:3' });
    expect(fit.document.nativeSlides[0]!.slide.elements).toHaveLength(1);
    expect(fit.document.nativeSlides[0]!.slide.elements[0]!.transform).toEqual({
      x: 10,
      y: 15,
      width: 50,
      height: 25,
    });
  });

  it('explicitly reports chart labels and tile-pixel limitations instead of silent approximation', () => {
    const source = fixture([
      {
        ...base('chart'),
        type: 'chart',
        chartType: 'bar',
        showLegend: true,
        showDataLabels: true,
        categories: ['A'],
        series: [{ id: 'series', name: 'Series', values: [3] }],
      },
    ]);
    source.nativeSlides[0]!.slide.background = { kind: 'image', resourceId: 'tile', mode: 'tile' };
    const fit = fitReachDeckPptxToStage(source, target);
    expect(fit.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'pptx.stage_fit.chart_appearance', severity: 'warning' }),
        expect.objectContaining({ code: 'pptx.stage_fit.image_appearance', severity: 'warning' }),
      ]),
    );
    expect(fit.document.nativeSlides[0]!.slide.elements[1]).toMatchObject({
      series: [{ values: [3] }],
      transform: { width: 150 },
    });
  });

  it('rejects invalid target dimensions', () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fitReachDeckPptxToStage(fixture([]), { ...target, width })).toThrow(
        'Invalid PPTX fit stage dimension',
      );
    }
  });
});
