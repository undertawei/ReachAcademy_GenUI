import type {
  ReachDeckNativeElementV2,
  ReachDeckTableCellV2,
  RichTextNode,
} from '@reachany/reach-deck-dsl';
import { REACH_PPTX_FONT_CATALOG } from '../pptx/style/font-catalog.js';
import {
  fitPptxTextFrame,
  type PptxFontMetricsProvider,
  type PptxTextRunForFit,
} from '../pptx/style/text-fitting.js';
import type { MaicCanvasPageIR, MaicDiagnostic, MaicDiagnosticLocation } from './types.js';

type Table = Extract<ReachDeckNativeElementV2, { type: 'table' }>;
type Transform = ReachDeckNativeElementV2['transform'];
const fontSet = {
  latin: 'Source Han Sans VF',
  eastAsia: 'Source Han Sans VF',
  complexScript: '',
  symbol: '',
};
const theme = { major: fontSet, minor: fontSet };
const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const positive = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : finite(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function paragraphRuns(paragraph: RichTextNode, paragraphIndex: number): PptxTextRunForFit[] {
  const fontSize = positive(paragraph.attrs?.fontSize, 16);
  const base: PptxTextRunForFit = {
    id: `${paragraphIndex}:strut`,
    text: '',
    font: { source: { kind: 'direct', family: 'Source Han Sans VF' }, script: 'eastAsia' },
    fontSizePt: fontSize,
    fontWeight: 400,
    italic: false,
    letterSpacingPt: finite(paragraph.attrs?.defaultLetterSpacing),
  };
  // The paragraph's CSS strut contributes a line box even when every inline run is smaller.
  return [
    base,
    ...(paragraph.content ?? []).map((node, index): PptxTextRunForFit => {
      const marks = node.marks ?? [];
      const style = marks.find((mark) => mark.type === 'textStyle')?.attrs;
      return {
        ...base,
        id: `${paragraphIndex}:${index}`,
        text: node.type === 'hardBreak' ? '\n' : (node.text ?? ''),
        font: {
          source: {
            kind: 'direct',
            family: typeof style?.fontFamily === 'string' ? style.fontFamily : 'Source Han Sans VF',
          },
          script: 'eastAsia',
        },
        fontSizePt: positive(style?.fontSize, fontSize),
        fontWeight: marks.some((mark) => mark.type === 'bold')
          ? 700
          : positive(style?.fontWeight, 400),
        italic: marks.some((mark) => mark.type === 'italic'),
        letterSpacingPt: finite(style?.letterSpacing, base.letterSpacingPt),
      };
    }),
  ];
}

function requiredCellHeight(
  cell: ReachDeckTableCellV2,
  width: number,
  metrics: PptxFontMetricsProvider,
): number {
  if (cell.text.orientation === 'vertical')
    throw new Error('Vertical table text cannot be measured.');
  const border = cell.style.stroke?.width ?? 0;
  const margins = cell.text.margins;
  let height = margins.top + margins.bottom + border * 2;
  for (const [index, paragraph] of (cell.text.doc.content ?? []).entries()) {
    const attrs = paragraph.attrs;
    const absoluteLineHeight = positive(attrs?.lineHeightPx, 0);
    // The shared fitter uses arbitrary consistent units. Here its Pt values are stage pixels.
    const paragraphMetrics: PptxFontMetricsProvider =
      absoluteLineHeight > 0
        ? {
            version: metrics.version,
            measureText(request) {
              const result = metrics.measureText(request);
              if (
                result &&
                ![result.advanceWidthPt, result.ascentPt, result.descentPt, result.lineGapPt].every(
                  (value) => Number.isFinite(value) && value >= 0,
                )
              )
                return undefined;
              return result
                ? { ...result, ascentPt: absoluteLineHeight, descentPt: 0, lineGapPt: 0 }
                : undefined;
            },
          }
        : metrics;
    const fitted = fitPptxTextFrame(
      {
        widthPt: width,
        heightPt: 1_000_000_000,
        insetLeftPt:
          margins.left +
          border +
          Math.max(0, finite(attrs?.leftIndent)) +
          // Reserve positive first-line indent on every line for conservative shared-fitter wrapping.
          Math.max(0, finite(attrs?.firstLineIndent)),
        insetRightPt: margins.right + border + Math.max(0, finite(attrs?.rightIndent)),
        insetTopPt: 0,
        insetBottomPt: 0,
        wrap: cell.text.wrap,
        tolerancePt: 0,
        autoFit: { mode: 'none' },
        paragraphs: [
          {
            id: String(index),
            runs: paragraphRuns(paragraph, index),
            lineSpacingMultiplier: absoluteLineHeight > 0 ? 1 : positive(attrs?.lineHeight, 1.5),
            spaceBeforePt: Math.max(0, finite(attrs?.spaceBefore)),
            spaceAfterPt: Math.max(0, finite(attrs?.spaceAfter)),
          },
        ],
      },
      REACH_PPTX_FONT_CATALOG,
      theme,
      paragraphMetrics,
    );
    if (!fitted.ok) throw new Error(fitted.diagnostics.map((entry) => entry.code).join(', '));
    height += fitted.measurement.heightPt;
  }
  if (!Number.isFinite(height)) throw new Error('Non-finite table text measurement.');
  return height;
}

function growTable(table: Table, metrics: PptxFontMetricsProvider): Table {
  const totalWidth = table.columnWidths.reduce((sum, width) => sum + width, 0);
  const totalHeight = table.rowHeights.reduce((sum, height) => sum + height, 0);
  const rows = table.rowHeights.map((height) => (height * table.transform.height) / totalHeight);
  const occupied = rows.map(() => table.columnWidths.map(() => false));
  const constraints: Array<{ row: number; span: number; height: number }> = [];
  table.rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.cells) {
      while (occupied[rowIndex]![column]) column++;
      const width =
        (table.columnWidths
          .slice(column, column + cell.columnSpan)
          .reduce((sum, value) => sum + value, 0) *
          table.transform.width) /
        totalWidth;
      for (let r = rowIndex; r < rowIndex + cell.rowSpan; r++)
        for (let c = column; c < column + cell.columnSpan; c++) occupied[r]![c] = true;
      constraints.push({
        row: rowIndex,
        span: cell.rowSpan,
        height: requiredCellHeight(cell, width, metrics),
      });
      column += cell.columnSpan;
    }
  });
  let grew = false;
  // Ordinary cells establish minima first; each spanning cell adds any deficit to its last row.
  for (const constraint of [
    ...constraints.filter((entry) => entry.span === 1),
    ...constraints.filter((entry) => entry.span > 1),
  ]) {
    const current = rows
      .slice(constraint.row, constraint.row + constraint.span)
      .reduce((sum, value) => sum + value, 0);
    if (constraint.height <= current + 0.01) continue;
    const lastRow = constraint.row + constraint.span - 1;
    rows[lastRow] = rows[lastRow]! + Math.ceil((constraint.height - current + 1) * 64) / 64;
    grew = true;
  }
  return grew
    ? {
        ...table,
        rowHeights: rows,
        transform: { ...table.transform, height: rows.reduce((sum, height) => sum + height, 0) },
      }
    : table;
}

function bounds(transform: Transform) {
  const angle = ((transform.rotation ?? 0) * Math.PI) / 180;
  const width =
    Math.abs(Math.cos(angle)) * transform.width + Math.abs(Math.sin(angle)) * transform.height;
  const height =
    Math.abs(Math.sin(angle)) * transform.width + Math.abs(Math.cos(angle)) * transform.height;
  const x = transform.x + (transform.width - width) / 2;
  const y = transform.y + (transform.height - height) / 2;
  return { x, y, right: x + width, bottom: y + height };
}
const overlaps = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) =>
  a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;

export function fitMaicTableRows(
  elements: ReachDeckNativeElementV2[],
  page: MaicCanvasPageIR,
  metrics: PptxFontMetricsProvider,
  diagnostics: MaicDiagnostic[],
): ReachDeckNativeElementV2[] {
  const locationFor = (element: ReachDeckNativeElementV2): MaicDiagnosticLocation => ({
    pageId: page.id,
    sourceOrder: page.sourceOrder,
    elementId: page.elements[element.zIndex]?.id,
  });
  const result = elements.map((element) => {
    if (element.type !== 'table') return element;
    try {
      return growTable(element, metrics);
    } catch (error) {
      diagnostics.push({
        code: 'maic.table.measurement_failed',
        severity: 'error',
        feature: 'table',
        message: 'Table row growth requires valid bundled-font measurements.',
        location: locationFor(element),
        details: { reason: error instanceof Error ? error.message : 'Unknown measurement failure' },
      });
      return element;
    }
  });
  result.forEach((element, index) => {
    const original = elements[index]!;
    if (element === original || element.type !== 'table') return;
    const before = bounds(original.transform);
    const after = bounds(element.transform);
    const location = locationFor(element);
    if (after.x < 0 || after.y < 0 || after.right > 1600 || after.bottom > 900)
      diagnostics.push({
        code: 'maic.table.growth_outside_page',
        severity: 'warning',
        feature: 'table',
        message: 'Table row growth extends beyond the page boundary.',
        location,
      });
    for (const [siblingIndex, sibling] of result.entries()) {
      if (siblingIndex === index || sibling.type === 'audio') continue;
      if (overlaps(before, bounds(elements[siblingIndex]!.transform))) continue;
      if (overlaps(after, bounds(sibling.transform)))
        diagnostics.push({
          code: 'maic.table.growth_overlap',
          severity: 'warning',
          feature: 'table',
          message: 'Table row growth overlaps another page element.',
          location,
          details: { otherElementId: page.elements[sibling.zIndex]?.id ?? sibling.id },
        });
    }
  });
  return result;
}
