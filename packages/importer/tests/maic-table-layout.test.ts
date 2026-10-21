import { describe, expect, it, vi } from 'vitest';
import { mapMaicToReachDeckV2, parseMaicCourse } from '../src/maic/index.js';
import { fitMaicTableRows } from '../src/maic/table-layout.js';
import type { MaicDiagnostic, MaicReachDeckV2MapperOptions } from '../src/maic/types.js';
import type { PptxFontMetricsProvider } from '../src/pptx/style/text-fitting.js';

const metrics: PptxFontMetricsProvider = {
  version: 'synthetic-em/v1',
  measureText: ({ text, fontSizePt, letterSpacingPt }) => ({
    advanceWidthPt: Array.from(text).length * (fontSizePt + letterSpacingPt),
    ascentPt: fontSizePt,
    descentPt: 0,
    lineGapPt: 0,
  }),
};
const cell = (text: string, style: Record<string, unknown> = {}) => ({
  text,
  rowspan: 1,
  colspan: 1,
  style: { fontsize: '20px', ...style },
});
const options: MaicReachDeckV2MapperOptions = {
  documentId: 'growth',
  applicationId: 'growth',
  title: 'Growth fixture',
  language: 'en-US',
  generatedAt: '2026-09-20T00:00:00Z',
  compatibilityTheme: {
    name: 'Fixture',
    background: '#FFFFFF',
    surface: '#FFFFFF',
    ink: '#000000',
    muted: '#666666',
    accent: '#FF0000',
    success: '#008000',
    warning: '#FF8800',
    fontDisplay: 'Source Han Sans VF',
    fontBody: 'Source Han Sans VF',
  },
};
function fixture(
  overrides: Record<string, unknown> = {},
  provider: PptxFontMetricsProvider | null = metrics,
  siblings: Record<string, unknown>[] = [],
) {
  const parsed = parseMaicCourse(
    JSON.stringify({
      title: 'Growth fixture',
      width: 1600,
      height: 900,
      slides: [
        {
          id: 'page',
          component_type: 'canvas',
          canvas_width: 1600,
          canvas_height: 900,
          elements: [
            {
              id: 'table',
              type: 'table',
              left: 100,
              top: 100,
              width: 220,
              height: 100,
              colWidths: [0.5, 0.5],
              rowHeights: [50, 50],
              data: [
                [cell('Short'), cell('Short')],
                [cell('Short'), cell('Long'.repeat(10))],
              ],
              ...overrides,
            },
            ...siblings,
          ],
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const result = mapMaicToReachDeckV2(parsed.ir, {
    ...options,
    tableFontMetrics: provider ?? undefined,
  });
  const table = result.ok ? result.document.nativeSlides[0]?.slide.elements[0] : undefined;
  return { result, table, page: parsed.ir.pages[0]! };
}
function tableOf(value: ReturnType<typeof fixture>) {
  if (value.table?.type !== 'table') throw new Error(JSON.stringify(value.result.diagnostics));
  return value.table;
}

describe('MAIC table row growth', () => {
  it('keeps short rows and every font size unchanged while growing only overflowing rows', () => {
    const grown = tableOf(fixture());
    const original = tableOf(fixture({}, null));
    expect(grown.rows).toEqual(original.rows);
    expect(original.rowHeights).toEqual([50, 50]);
    expect(grown.rowHeights[0]).toBe(50);
    expect(grown.rowHeights[1]).toBeGreaterThan(200);
    expect(grown.transform).toMatchObject({ x: 100, y: 100, width: 220 });
    expect(grown.transform.height).toBe(grown.rowHeights.reduce((sum, height) => sum + height, 0));
    expect(original.columnWidths).toEqual(grown.columnWidths);
    expect(fixture()).toEqual(fixture());
  });

  it('leaves fully fitting tables and proportional source grids untouched', () => {
    const table = tableOf(
      fixture({
        data: [
          [cell('a'), cell('b')],
          [cell('c'), cell('d')],
        ],
        rowHeights: [5, 5],
      }),
    );
    expect(table.rowHeights).toEqual([5, 5]);
    expect(table.transform.height).toBe(100);
  });

  it('normalizes the rendered row minima before growing a grid scaled to its frame', () => {
    const table = tableOf(fixture({ rowHeights: [5, 5] }));
    expect(table.rowHeights[0]).toBe(50);
    expect(table.rowHeights[1]).toBeGreaterThan(200);
  });

  it('uses rendered colspan widths and skips rowspan-occupied columns', () => {
    const table = tableOf(
      fixture({
        width: 300,
        height: 100,
        colWidths: [0.1, 0.3, 0.6],
        data: [
          [
            { ...cell('x'), rowspan: 2 },
            { ...cell('abcdefghij'), colspan: 2 },
          ],
          [cell('abc'), cell('abcdefgh')],
        ],
      }),
    );
    expect(table.rowHeights).toEqual([50, 50]);
  });

  it('satisfies ordinary rows before adding a merged cell deficit to its last row', () => {
    const table = tableOf(
      fixture({
        data: [[{ ...cell('abcdefghij'.repeat(5)), rowspan: 2 }, cell('a')], [cell('b')]],
      }),
    );
    expect(table.rowHeights[0]).toBe(50);
    expect(table.rowHeights[1]).toBeGreaterThan(250);
    const diagnostics: MaicDiagnostic[] = [];
    const page = fixture().page;
    if (page.kind !== 'canvas') throw new Error('Expected canvas');
    expect(fitMaicTableRows([table], page, metrics, diagnostics)).toEqual([table]);
    expect(diagnostics).toEqual([]);
  });

  it('accounts for borders, explicit breaks, mixed typography, line spacing and indents', () => {
    const measureText = vi.fn(metrics.measureText);
    const table = tableOf(
      fixture(
        {
          height: 40,
          rowHeights: [40],
          width: 240,
          colWidths: [1],
          outline: { width: 3, color: '#000000', style: 'solid' },
          data: [
            [
              cell(
                '<p style="line-height:40px;margin-top:5px;margin-bottom:7px;margin-left:10px;text-indent:5px">a<br><span style="font-family:KaiTi;font-size:30px;font-weight:700;font-style:italic;letter-spacing:2px">b</span>\nc</p>',
              ),
            ],
          ],
        },
        { ...metrics, measureText },
      ),
    );
    expect(table.rowHeights[0]).toBeGreaterThanOrEqual(148);
    expect(measureText).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'LXGW WenKai',
        text: 'b',
        fontSizePt: 30,
        fontWeight: 700,
        italic: true,
        letterSpacingPt: 2,
      }),
    );
    const withoutBorder = tableOf(
      fixture({
        width: 110,
        colWidths: [1],
        height: 40,
        rowHeights: [40],
        data: [[cell('abcde')]],
      }),
    );
    const withBorder = tableOf(
      fixture({
        width: 110,
        colWidths: [1],
        height: 40,
        rowHeights: [40],
        data: [[cell('abcde')]],
        outline: { width: 3, color: '#000000', style: 'solid' },
      }),
    );
    expect(withBorder.transform.height).toBeGreaterThan(withoutBorder.transform.height + 20);
  });

  it.each([
    { version: 'missing', measureText: () => undefined },
    {
      version: 'invalid',
      measureText: () => ({ advanceWidthPt: NaN, ascentPt: 20, descentPt: 0, lineGapPt: 0 }),
    },
    {
      version: 'throws',
      measureText: () => {
        throw new Error('unavailable');
      },
    },
  ])('reports failed measurements as page errors ($version)', (provider) => {
    const { result } = fixture({}, provider);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'maic.table.measurement_failed',
        severity: 'error',
        location: { pageId: 'page', sourceOrder: 1, elementId: 'table' },
      }),
    );
  });

  it('warns for new content collisions and page overflow, excluding existing background containment', () => {
    const { result } = fixture({ top: 700 }, metrics, [
      { id: 'below', type: 'text', left: 100, top: 810, width: 220, height: 40, content: 'Below' },
      {
        id: 'background',
        type: 'shape',
        left: 0,
        top: 0,
        width: 1600,
        height: 900,
        path: 'M 0 0 L 100 0 L 100 100 Z',
        viewBox: [100, 100],
        fill: '#FFFFFF',
      },
    ]);
    expect(result.ok).toBe(true);
    const diagnostics = result.diagnostics.filter((entry) =>
      entry.code.startsWith('maic.table.growth'),
    );
    expect(diagnostics.map((entry) => entry.code)).toEqual([
      'maic.table.growth_outside_page',
      'maic.table.growth_overlap',
    ]);
    expect(diagnostics[1]!.details).toEqual({ otherElementId: 'below' });
    expect(diagnostics.every((entry) => entry.severity === 'warning')).toBe(true);
  });
});
