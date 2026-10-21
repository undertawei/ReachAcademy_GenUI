import { describe, expect, it } from 'vitest';

import {
  createMaicCandidateDigest,
  mapMaicToReachDeckV2,
  parseMaicCourse,
} from '../src/maic/index.js';

const chart = {
  id: 'ginkgo_chart',
  type: 'chart',
  left: 530,
  top: 180,
  width: 400,
  height: 220,
  chartType: 'line',
  data: { labels: ['9月', '10月', '11月'], legends: ['叶片黄色程度(%)'], series: [[10, 50, 100]] },
  themeColors: ['#ed7d31'],
  options: { lineSmooth: true },
};
const options = {
  applicationId: 'chart-import',
  documentId: 'chart-document',
  title: 'Chart import',
  language: 'zh-CN',
  generatedAt: '2026-09-28T00:00:00.000Z',
  compatibilityTheme: {
    name: 'Import',
    background: '#FFFFFF',
    surface: '#F8FAFC',
    ink: '#111827',
    muted: '#64748B',
    accent: '#2563EB',
    success: '#15803D',
    warning: '#B45309',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  },
};
function parse(element: Record<string, unknown> = chart) {
  const result = parseMaicCourse(
    new TextEncoder().encode(
      JSON.stringify({
        title: 'Chart lesson',
        width: 1000,
        height: 562.5,
        slides: [
          { id: 'chart-page', component_type: 'canvas', elements: [element] },
          { id: 'other-page', component_type: 'canvas', elements: [] },
        ],
      }),
    ),
  );
  if (!result.ok) throw new Error('Expected a parsed course');
  return result;
}
function map(element: Record<string, unknown> = chart) {
  const parsed = parse(element);
  const result = mapMaicToReachDeckV2(parsed.ir, {
    ...options,
    includePageIds: parsed.capabilityReport.pageReports
      .filter((page) => page.status !== 'error')
      .map((page) => page.pageId),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return { parsed, result };
}

describe('MAIC native line charts', () => {
  it('retains the ginkgo chart values, legend, color, geometry and page with a smooth-line warning', () => {
    const { parsed, result } = map();
    expect(parsed.capabilityReport.pageReports[0]?.status).toBe('warning');
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: 'maic.chart.option_unsupported',
        severity: 'warning',
        feature: 'chart',
        location: {
          pageId: 'chart-page',
          sourceOrder: 1,
          elementId: 'ginkgo_chart',
          field: 'options.lineSmooth',
        },
      }),
    ]);
    expect(result.document.pages).toHaveLength(2);
    expect(result.document.resources.media).toEqual([]);
    expect(result.document.nativeSlides[0]?.slide.elements).toEqual([
      expect.objectContaining({
        type: 'chart',
        chartType: 'line',
        showLegend: true,
        showDataLabels: false,
        transform: { x: 848, y: 288, width: 640, height: 352 },
        categories: ['9月', '10月', '11月'],
        series: [
          {
            id: expect.any(String),
            name: '叶片黄色程度(%)',
            values: [10, 50, 100],
            color: { kind: 'srgb', value: '#ED7D31' },
          },
        ],
      }),
    ]);
    const repeated = map().result;
    expect(createMaicCandidateDigest(repeated.document)).toBe(
      createMaicCandidateDigest(result.document),
    );
  });

  it('retains multiple series, null gaps and source transforms with stable distinct series ids', () => {
    const { parsed, result } = map({
      ...chart,
      rotate: 20,
      flipH: true,
      opacity: 0.5,
      data: {
        labels: ['A', 'B'],
        legends: ['First', 'Second'],
        series: [
          [-5, null],
          [0, 10],
        ],
      },
      themeColors: ['#123', 'rgba(255, 0, 0, 0.5)'],
      options: { lineSmooth: false },
    });
    expect(parsed.diagnostics).toEqual([]);
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    if (element?.type !== 'chart' || element.chartType !== 'line')
      throw new Error('Expected native line chart');
    expect(element.transform).toMatchObject({ rotation: 20, flipHorizontal: true });
    expect(element.opacity).toBe(0.5);
    expect(element.series.map((entry) => entry.values)).toEqual([
      [-5, null],
      [0, 10],
    ]);
    expect(element.series.map((entry) => entry.color)).toEqual([
      { kind: 'srgb', value: '#112233' },
      { kind: 'srgb', value: '#FF0000', alpha: 0.5 },
    ]);
    expect(new Set(element.series.map((entry) => entry.id)).size).toBe(2);
  });

  it.each([
    ['missing data', { data: null }, 'data'],
    ['empty labels', { data: { ...chart.data, labels: [] } }, 'data.labels'],
    ['nonstring label', { data: { ...chart.data, labels: ['A', 2, 'C'] } }, 'data.labels'],
    ['empty series', { data: { ...chart.data, series: [] } }, 'data.series'],
    ['missing legend', { data: { ...chart.data, legends: [] } }, 'data.legends'],
    ['blank legend', { data: { ...chart.data, legends: [' '] } }, 'data.legends'],
    ['misaligned values', { data: { ...chart.data, series: [[10, 50]] } }, 'data.series[0]'],
    [
      'nonnumeric value',
      { data: { ...chart.data, series: [[10, '50', 100]] } },
      'data.series[0][1]',
    ],
  ])('diagnoses %s precisely and excludes only the invalid chart page', (_name, invalid, field) => {
    const { parsed, result } = map({ ...chart, ...invalid });
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'maic.chart.data_invalid',
        severity: 'error',
        location: { pageId: 'chart-page', sourceOrder: 1, elementId: 'ginkgo_chart', field },
      }),
    );
    expect(parsed.capabilityReport.pageReports.map((page) => page.status)).toEqual(['error', 'ok']);
    expect(result.document.pages).toHaveLength(1);
  });

  it('warns for unsupported display options and malformed colors without dropping valid data', () => {
    const { parsed, result } = map({
      ...chart,
      themeColors: ['not-a-color'],
      options: { lineSmooth: false, axisMinimum: 20 },
      gridColor: '#123456',
    });
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.location?.field).sort()).toEqual([
      'gridColor',
      'options.axisMinimum',
      'themeColors[0]',
    ]);
    expect(parsed.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(result.document.pages).toHaveLength(2);
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({ type: 'chart', series: [{ values: [10, 50, 100] }] });
    if (element?.type !== 'chart' || element.chartType !== 'line')
      throw new Error('Expected native line chart');
    expect(element.series[0]?.color).toBeUndefined();
  });

  it('does not reinterpret an unverified chart type as a line chart', () => {
    const { parsed, result } = map({ ...chart, chartType: 'radar' });
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'maic.chart.type_unsupported',
        severity: 'error',
        location: expect.objectContaining({ field: 'chartType' }),
      }),
    );
    expect(result.document.pages).toHaveLength(1);
  });
});
