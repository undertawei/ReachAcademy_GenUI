import { readMaicLineChart } from './chart.js';
import {
  parseReachDeckDocumentV2,
  reachDeckNarrationMarkdownFromSegments,
  REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
  ReachDeckNarrationMarkdownError,
  richTextFromPlainText,
  type QuizQuestion,
  type QuizQuestionBlank,
  type QuizQuestionOption,
  type ReachDeckFillV2,
  type ReachDeckNativeElementV2,
  type ReachDeckNativeSlideV2,
  type ReachDeckPublishedPage,
  type ReachDeckStrokeV2,
  type ReachDeckImageElementV2,
} from '@reachany/reach-deck-dsl';

import { createStableMaicId } from './identity.js';
import { readMaicCanvasImageBackground } from './background.js';
import { maicColor as color, maicCssColor, maicSolidFill } from './style.js';
import { maicTextFrame as textFrame } from './text.js';
import { maicTableCellFill, maicTableCellText } from './table.js';
import { fitMaicTableRows } from './table-layout.js';
import type {
  MaicCanvasPageIR,
  MaicCourseIR,
  MaicDiagnostic,
  MaicElementIR,
  MaicReachDeckV2MapperOptions,
  MaicReachDeckV2MappingResult,
  MaicReachDeckV2PageReport,
} from './types.js';
import { MAIC_IMPORTER_VERSION, MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION } from './version.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const boolean = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback;

const stroke = (source: Record<string, unknown>, scale: number): ReachDeckStrokeV2 => ({
  // Native strokes require a positive width; a disabled source stroke stays invisible.
  width: number(source.width, 1) > 0 ? number(source.width, 1) * scale : 1,
  fill: color(
    number(source.width, 1) <= 0
      ? 'transparent'
      : source.color === undefined
        ? '#000000'
        : maicCssColor(source.color)
          ? source.color
          : 'transparent',
  ),
  dash: source.style === 'dashed' ? 'dash' : source.style === 'dotted' ? 'dot' : 'solid',
});

const transform = (element: MaicElementIR, scaleX: number, scaleY: number) => ({
  x: element.left * scaleX,
  y: element.top * scaleY,
  width: Math.max(1, element.width * scaleX),
  height: Math.max(1, element.height * scaleY),
  ...(element.rotate ? { rotation: element.rotate } : {}),
  ...(boolean(element.source.flipH) ? { flipHorizontal: true } : {}),
  ...(boolean(element.source.flipV) ? { flipVertical: true } : {}),
});

const mediaReference = (ir: MaicCourseIR, pageId: string, elementId: string) =>
  ir.mediaReferences.find((entry) => entry.pageId === pageId && entry.elementId === elementId);

const gradientFill = (
  source: unknown,
  requireStrictSource = false,
): ReachDeckFillV2 | undefined => {
  if (!isRecord(source) || !isRecord(source.gradient) || !Array.isArray(source.gradient.colors)) {
    return undefined;
  }
  const gradient = source.gradient;
  const colors: unknown[] = source.gradient.colors;
  if (!requireStrictSource) {
    const stops = colors.filter(isRecord).map((entry) => ({
      offset: Math.max(0, Math.min(1, number(entry.pos, 0) / 100)),
      color: color(entry.color),
    }));
    if (stops.length < 2) return undefined;
    return {
      kind: 'gradient',
      angle: number(gradient.rotate, 0) + 90,
      stops,
      ...(gradient.type === 'radial' ? { gradientType: 'radial' as const } : {}),
    };
  }
  if (
    source.type !== 'gradient' ||
    (gradient.type !== 'linear' && gradient.type !== 'radial') ||
    typeof gradient.rotate !== 'number' ||
    !Number.isFinite(gradient.rotate) ||
    colors.length < 2 ||
    colors.length > 32
  ) {
    return undefined;
  }
  let previousOffset = -1;
  const stops: Array<Extract<ReachDeckFillV2, { kind: 'gradient' }>['stops'][number]> = [];
  for (const entry of colors) {
    if (
      !isRecord(entry) ||
      typeof entry.pos !== 'number' ||
      !Number.isFinite(entry.pos) ||
      entry.pos < 0 ||
      entry.pos > 100 ||
      entry.pos / 100 < previousOffset ||
      maicCssColor(entry.color) === undefined
    ) {
      return undefined;
    }
    previousOffset = entry.pos / 100;
    stops.push({ offset: previousOffset, color: color(entry.color) });
  }
  return {
    kind: 'gradient',
    angle: gradient.rotate + 90,
    stops,
    ...(gradient.type === 'radial' ? { gradientType: 'radial' as const } : {}),
  };
};

const mapCanvasBackground = (
  ir: MaicCourseIR,
  page: MaicCanvasPageIR,
  options: MaicReachDeckV2MapperOptions,
): { fill: ReachDeckFillV2; degraded: boolean; unresolved: boolean } => {
  const source = page.background;
  const white: ReachDeckFillV2 = { kind: 'solid', color: color('#FFFFFF') };
  if (source === undefined || source === null)
    return { fill: white, degraded: false, unresolved: false };
  if (!isRecord(source)) {
    return maicCssColor(source) === undefined
      ? { fill: white, degraded: true, unresolved: false }
      : {
          fill: { kind: 'solid', color: color(source) },
          degraded: false,
          unresolved: false,
        };
  }

  if (source.type === 'gradient') {
    const fill = gradientFill(source, true);
    return fill
      ? { fill, degraded: false, unresolved: false }
      : { fill: white, degraded: true, unresolved: false };
  }
  if (source.type === 'solid') {
    return maicCssColor(source.color) === undefined
      ? { fill: white, degraded: true, unresolved: false }
      : {
          fill: { kind: 'solid', color: color(source.color) },
          degraded: false,
          unresolved: false,
        };
  }
  const imageBackground = readMaicCanvasImageBackground(source);
  if (imageBackground !== undefined) {
    if (page.backgroundMediaReferenceId === undefined) {
      // The parser already reports the missing or rejected URL for this recognized shape.
      return { fill: white, degraded: false, unresolved: false };
    }
    const reference = ir.mediaReferences.find(
      (entry) =>
        entry.id === page.backgroundMediaReferenceId &&
        entry.pageId === page.id &&
        entry.kind === 'image' &&
        entry.elementId === undefined,
    );
    const resolved = reference === undefined ? undefined : options.media?.[reference.id];
    if (reference === undefined || resolved === undefined) {
      return { fill: white, degraded: false, unresolved: true };
    }
    return {
      fill: {
        kind: 'image',
        resourceId: createStableMaicId('media', [options.applicationId, reference.id]),
        mode: imageBackground.mode,
      },
      degraded: false,
      unresolved: false,
    };
  }
  if (source.type === undefined && !('gradient' in source) && maicCssColor(source.color)) {
    return {
      fill: { kind: 'solid', color: color(source.color) },
      degraded: false,
      unresolved: false,
    };
  }
  return { fill: white, degraded: true, unresolved: false };
};

interface ValidatedMaicTable {
  data: MaicPositionedTableGrid;
  columnWidths: number[];
  rowHeights: number[];
}

const positiveFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * 椭圆裁剪映射出的图片填充 insets 必须落在 DSL 对 fill.insets 的约束内
 * （每边 [-10, 1]，且 left+right / top+bottom 小于 1），否则 parseReachDeckDocumentV2
 * 会抛错，整份课件退成 maic.mapping.invalid_document fatal——连同页面里其他好端端
 * 的页一起导不进来。窄裁剪窗口（宽或高不足原图约 9.1%）算出的出血值就会越界。
 */
const ELLIPSE_FILL_INSET_BOUNDS = Object.freeze({ min: -10, max: 1 });

const isImportableEllipseFillInsets = (insets: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): boolean =>
  Object.values(insets).every(
    (value) =>
      Number.isFinite(value) &&
      value >= ELLIPSE_FILL_INSET_BOUNDS.min &&
      value <= ELLIPSE_FILL_INSET_BOUNDS.max,
  ) &&
  insets.left + insets.right < 1 &&
  insets.top + insets.bottom < 1;

const positiveIntegerOrDefault = (value: unknown): number | undefined =>
  value === undefined
    ? 1
    : typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : undefined;

type MaicTableRow = ReadonlyArray<Readonly<Record<string, unknown>>>;
type MaicTableGrid = ReadonlyArray<MaicTableRow>;
type MaicPositionedTableGrid = Array<
  Array<{ record: Readonly<Record<string, unknown>>; columnIndex: number }>
>;

/**
 * 按 HTML <table> 语义读网格：被 colspan/rowspan 覆盖的格在行数组里省略，
 * 于是每个单元格都推进列指针。保留物理列坐标，无法自洽时返回 undefined。
 */
function readMaicTableAsHtmlGrid(
  data: MaicTableGrid,
  columnCount: number,
): MaicPositionedTableGrid | undefined {
  const occupied = data.map(() => Array.from({ length: columnCount }, () => false));
  const rows: MaicPositionedTableGrid = data.map(() => []);
  for (let rowIndex = 0; rowIndex < data.length; rowIndex += 1) {
    const row = data[rowIndex]!;
    if (row.length === 0) return undefined;
    let columnIndex = 0;
    for (const cell of row) {
      while (columnIndex < columnCount && occupied[rowIndex]![columnIndex]) columnIndex += 1;
      const rowSpan = positiveIntegerOrDefault(cell.rowspan);
      const columnSpan = positiveIntegerOrDefault(cell.colspan);
      if (
        rowSpan === undefined ||
        columnSpan === undefined ||
        columnIndex + columnSpan > columnCount ||
        rowIndex + rowSpan > data.length
      ) {
        return undefined;
      }
      for (let occupiedRow = rowIndex; occupiedRow < rowIndex + rowSpan; occupiedRow += 1) {
        for (
          let occupiedColumn = columnIndex;
          occupiedColumn < columnIndex + columnSpan;
          occupiedColumn += 1
        ) {
          if (occupied[occupiedRow]![occupiedColumn]) return undefined;
          occupied[occupiedRow]![occupiedColumn] = true;
        }
      }
      rows[rowIndex]!.push({ record: cell, columnIndex });
      columnIndex += columnSpan;
    }
    if (occupied[rowIndex]!.some((value) => !value)) return undefined;
  }
  return rows;
}

/**
 * 按完整网格语义读网格：MAIC 导出会保留被合并覆盖的单元格作为空占位（内容为空、
 * 自身不再声明跨度），所以每行长度恒等于列数。这里把占位格剔除，返回与 HTML 语义
 * 等价的行数组，交给下游按 rowSpan/columnSpan 渲染。无法自洽时返回 undefined。
 */
function readMaicTableAsFullGrid(
  data: MaicTableGrid,
  columnCount: number,
): MaicPositionedTableGrid | undefined {
  if (!data.every((row) => row.length === columnCount)) return undefined;
  const occupied = data.map(() => Array.from({ length: columnCount }, () => false));
  const rows: MaicPositionedTableGrid = data.map(() => []);
  for (let rowIndex = 0; rowIndex < data.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cell = data[rowIndex]![columnIndex]!;
      const rowSpan = positiveIntegerOrDefault(cell.rowspan);
      const columnSpan = positiveIntegerOrDefault(cell.colspan);
      if (rowSpan === undefined || columnSpan === undefined) return undefined;
      if (occupied[rowIndex]![columnIndex]) {
        // 占位格自己再声明跨度，说明这份数据不是完整网格，交回上层按 HTML 语义判定。
        if (rowSpan !== 1 || columnSpan !== 1) return undefined;
        continue;
      }
      if (columnIndex + columnSpan > columnCount || rowIndex + rowSpan > data.length) {
        return undefined;
      }
      for (let occupiedRow = rowIndex; occupiedRow < rowIndex + rowSpan; occupiedRow += 1) {
        for (
          let occupiedColumn = columnIndex;
          occupiedColumn < columnIndex + columnSpan;
          occupiedColumn += 1
        ) {
          if (occupied[occupiedRow]![occupiedColumn]) return undefined;
          occupied[occupiedRow]![occupiedColumn] = true;
        }
      }
      rows[rowIndex]!.push({ record: cell, columnIndex });
    }
    if (rows[rowIndex]!.length === 0) return undefined;
  }
  return rows;
}

/**
 * MAIC 表格有两种导出形态：省略被合并格的 HTML 语义，和保留空占位格的完整网格。
 * 先按 HTML 语义读（保持既有行为），读不通再按完整网格读，避免把合法的合并单元格
 * 表格误判成 maic.table.invalid 而整页导不进来。
 */
function readMaicTableGrid(
  data: MaicTableGrid,
  columnCount: number,
): MaicPositionedTableGrid | undefined {
  return readMaicTableAsHtmlGrid(data, columnCount) ?? readMaicTableAsFullGrid(data, columnCount);
}

function validateMaicTable(
  element: MaicElementIR,
  scaleX: number,
  scaleY: number,
): ValidatedMaicTable | undefined {
  const source = element.source;
  if (
    !Array.isArray(source.data) ||
    source.data.length === 0 ||
    !source.data.every(
      (row): row is ReadonlyArray<Readonly<Record<string, unknown>>> =>
        Array.isArray(row) && row.every(isRecord),
    ) ||
    !Array.isArray(source.colWidths) ||
    source.colWidths.length === 0 ||
    !source.colWidths.every(positiveFiniteNumber)
  ) {
    return undefined;
  }
  const data = readMaicTableGrid(source.data, source.colWidths.length);
  if (data === undefined) return undefined;

  const columnWidths = source.colWidths.map((width) => width * scaleX);

  let rawRowHeights: number[];
  if (source.rowHeights !== undefined) {
    if (
      !Array.isArray(source.rowHeights) ||
      source.rowHeights.length !== data.length ||
      !source.rowHeights.every(positiveFiniteNumber)
    ) {
      return undefined;
    }
    rawRowHeights = source.rowHeights;
  } else {
    if (!positiveFiniteNumber(element.height) || !positiveFiniteNumber(source.cellMinHeight)) {
      return undefined;
    }
    const derivedRowHeight = element.height / data.length;
    if (derivedRowHeight < source.cellMinHeight) return undefined;
    rawRowHeights = Array.from({ length: data.length }, () => derivedRowHeight);
  }
  return {
    data,
    columnWidths,
    rowHeights: rawRowHeights.map((height) => height * scaleY),
  };
}

const mapCanvasElement = (
  ir: MaicCourseIR,
  page: MaicCanvasPageIR,
  element: MaicElementIR,
  options: MaicReachDeckV2MapperOptions,
  zIndex: number,
  diagnostics: MaicDiagnostic[],
): ReachDeckNativeElementV2 | undefined => {
  const source = element.source;
  const scaleX = 1600 / page.width;
  const scaleY = 900 / page.height;
  const base = {
    id: createStableMaicId('element', [options.applicationId, page.id, element.id]),
    transform: transform(element, scaleX, scaleY),
    zIndex,
    source: { partPath: `/maic/pages/${page.sourceOrder}`, sourceId: element.id },
    ...(number(source.opacity, 1) < 1 ? { opacity: number(source.opacity, 1) } : {}),
  };
  if (element.type === 'chart') {
    const chart = readMaicLineChart(
      source,
      { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
      diagnostics,
    );
    if (chart === undefined) return undefined;
    return {
      ...base,
      type: 'chart',
      chartType: 'line',
      showLegend: true,
      showDataLabels: false,
      categories: chart.categories,
      series: chart.series.map((series, index) => ({
        ...series,
        id: createStableMaicId('chart-series', [base.id, String(index)]),
      })),
    };
  }
  if (element.type === 'text') {
    const content = text(source.content);
    return {
      ...base,
      type: 'textFrame',
      fillSizing: 'content',
      text: textFrame(content, source, scaleX),
      style: {
        fill: maicSolidFill(source.fill),
        ...(isRecord(source.outline) ? { stroke: stroke(source.outline, scaleX) } : {}),
      },
    };
  }
  if (element.type === 'shape') {
    const shapeText = isRecord(source.text) ? text(source.text.content) : '';
    let fill = gradientFill(source) ?? maicSolidFill(source.fill);
    if (typeof source.pattern === 'string' && source.pattern) {
      const reference = mediaReference(ir, page.id, element.id);
      if (!reference || !options.media?.[reference.id]) {
        diagnostics.push({
          code: 'maic.resource.unresolved',
          severity: 'error',
          feature: 'image',
          message: 'Referenced MAIC image fill has not been promoted to managed storage.',
          location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
        });
        return undefined;
      }
      fill = {
        kind: 'image',
        resourceId: createStableMaicId('media', [options.applicationId, reference.id]),
        mode: 'cover',
      };
    }
    const viewBox = Array.isArray(source.viewBox) ? source.viewBox : [];
    const shadow = isRecord(source.shadow) ? source.shadow : undefined;
    return {
      ...base,
      type: 'shape',
      geometry:
        typeof source.path === 'string' &&
        source.path &&
        number(viewBox[0], 0) > 0 &&
        number(viewBox[1], 0) > 0
          ? {
              kind: 'custom',
              viewBox: { width: number(viewBox[0], 1), height: number(viewBox[1], 1) },
              path: source.path,
            }
          : { kind: 'preset', preset: 'rect' },
      style: {
        fill,
        ...(isRecord(source.outline) ? { stroke: stroke(source.outline, scaleX) } : {}),
        ...(shadow
          ? {
              effects: {
                shadow: {
                  color: color(shadow.color),
                  blur: Math.max(0, number(shadow.blur, 0) * scaleX),
                  distance: Math.hypot(number(shadow.h, 0), number(shadow.v, 0)) * scaleX,
                  angle: (Math.atan2(number(shadow.v, 0), number(shadow.h, 0)) * 180) / Math.PI,
                },
              },
            }
          : {}),
      },
      ...(shapeText
        ? {
            text: textFrame(
              shapeText,
              { lineHeight: 1.2, ...(source.text as Record<string, unknown>) },
              scaleX,
            ),
          }
        : {}),
    };
  }
  if (element.type === 'line') {
    const start = Array.isArray(source.start) ? source.start : [0, 0];
    const end = Array.isArray(source.end) ? source.end : [element.width, element.height];
    const sx = number(start[0], 0) * scaleX;
    const sy = number(start[1], 0) * scaleY;
    const ex = number(end[0], element.width) * scaleX;
    const ey = number(end[1], element.height) * scaleY;
    const x = Math.min(sx, ex);
    const y = Math.min(sy, ey);
    const points = Array.isArray(source.points) ? source.points : [];
    const marker = (value: unknown) =>
      value === 'arrow' || value === 'diamond' || value === 'oval' || value === 'triangle'
        ? value
        : 'none';
    return {
      ...base,
      type: 'line',
      transform: {
        ...base.transform,
        x: base.transform.x + x,
        y: base.transform.y + y,
        width: Math.max(number(source.width, 1) * scaleX, Math.abs(ex - sx)),
        height: Math.max(number(source.width, 1) * scaleY, Math.abs(ey - sy)),
      },
      start: {
        x: sx - x,
        y: sy - y,
        marker: marker(points[0]),
        ...(marker(points[0]) !== 'none' ? { markerSize: 3, markerAnchor: 'center' as const } : {}),
      },
      end: {
        x: ex - x,
        y: ey - y,
        marker: marker(points[1]),
        ...(marker(points[1]) !== 'none' ? { markerSize: 3, markerAnchor: 'center' as const } : {}),
      },
      routing: 'straight',
      connector: false,
      stroke: stroke(source, scaleX),
    };
  }
  if (element.type === 'image' || element.type === 'audio') {
    const reference = mediaReference(ir, page.id, element.id);
    const resolved = reference ? options.media?.[reference.id] : undefined;
    if (!reference || !resolved) {
      diagnostics.push({
        code: 'maic.resource.unresolved',
        severity: 'error',
        feature: element.type,
        message: 'Referenced MAIC media has not been promoted to managed storage.',
        location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
      });
      return undefined;
    }
    const resourceId = createStableMaicId('media', [options.applicationId, reference.id]);
    let crop: ReachDeckImageElementV2['crop'];
    let ellipseFillInsets:
      | NonNullable<Extract<ReachDeckFillV2, { kind: 'image' }>['insets']>
      | undefined;
    if (element.type === 'image' && isRecord(source.clip)) {
      const range = source.clip.range;
      const clipShape = source.clip.shape;
      // MAIC permits crop windows beyond the bitmap, leaving transparent edges.
      // Native crop insets already support this same negative-inset convention.
      //
      // clip.shape 除 rect 外还会出现 roundRect 与 ellipse，两者的 range 都是该
      // 形状的外接矩形。ellipse 会被映射成椭圆 shape + 图片填充（原生就会按轮廓
      // 裁剪），roundRect 目前仍降级成外接矩形并留一条 warning。把它们判成 error
      // 会让整页被丢弃，而线上课件里 ellipse 裁剪非常常见（《两宋绘画2》50 页里
      // 就有 6 页因此整页丢失）。
      if (
        (clipShape !== 'rect' && clipShape !== 'roundRect' && clipShape !== 'ellipse') ||
        !Array.isArray(range) ||
        !Array.isArray(range[0]) ||
        !Array.isArray(range[1]) ||
        ![...range[0], ...range[1]].every(
          (part) => typeof part === 'number' && Number.isFinite(part),
        ) ||
        range[0].length !== 2 ||
        range[1].length !== 2 ||
        // 边界是 DSL crop insets [-10, 1] 的镜像:left/top = range[0]/100,
        // right/bottom = 1 - range[1]/100。
        range[0].some((part) => part < -1000 || part > 100) ||
        range[1].some((part) => part < 0 || part > 1100) ||
        range[1][0] <= range[0][0] ||
        range[1][1] <= range[0][1]
      ) {
        diagnostics.push({
          code: 'maic.image.invalid_crop',
          severity: 'error',
          feature: 'image',
          message: 'MAIC image crop must be a positive rectangular window.',
          location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
        });
        return undefined;
      }
      if (clipShape === 'roundRect')
        diagnostics.push({
          code: 'maic.image.rounded_clip_degraded',
          severity: 'warning',
          feature: 'image',
          message: 'Rounded MAIC image clipping is imported as a rectangular crop.',
          location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
        });
      crop = {
        left: range[0][0] / 100,
        top: range[0][1] / 100,
        right: 1 - range[1][0] / 100,
        bottom: 1 - range[1][1] / 100,
      };
      if (clipShape === 'ellipse') {
        // clip.range 是 srcRect 语义（裁剪窗口占原图的比例），而图片填充的 insets
        // 是 fillRect 语义（图片相对填充盒的偏移）。裁剪窗口要正好铺满盒子，图片
        // 在盒内的宽度就是 1/sw、左边缘落在 -sx0/sw，右侧由此反推；负值即出血，
        // 正好被椭圆轮廓裁掉。
        const sx0 = range[0][0] / 100;
        const sy0 = range[0][1] / 100;
        const sw = range[1][0] / 100 - sx0;
        const sh = range[1][1] / 100 - sy0;
        // 全幅裁剪时 -0/sw 会得到 -0，规整成 0 以免文档里出现负零。
        const noNegativeZero = (value: number): number => (value === 0 ? 0 : value);
        const candidateInsets = {
          left: noNegativeZero(-sx0 / sw),
          top: noNegativeZero(-sy0 / sh),
          right: noNegativeZero(1 - (1 - sx0) / sw),
          bottom: noNegativeZero(1 - (1 - sy0) / sh),
        };
        if (isImportableEllipseFillInsets(candidateInsets)) {
          ellipseFillInsets = candidateInsets;
        } else {
          // 越界就退回外接矩形裁剪，跟 roundRect 同一套降级：丢的是椭圆轮廓，
          // 而不是整份课件。crop 已经按 range 算好，直接沿用即可。
          diagnostics.push({
            code: 'maic.image.ellipse_clip_degraded',
            severity: 'warning',
            feature: 'image',
            message:
              'Elliptical MAIC image clipping is imported as a rectangular crop because the clip window is too narrow to express as fill insets.',
            location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
          });
        }
      }
    }
    const filters: NonNullable<ReachDeckImageElementV2['filters']> = {};
    if (isRecord(source.filters))
      for (const name of ['brightness', 'contrast', 'saturate'] as const) {
        const value = source.filters[name];
        const amount =
          typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
            ? Number(value)
            : typeof value === 'number'
              ? value
              : NaN;
        if (Number.isFinite(amount) && amount >= 0 && amount <= 10) filters[name] = amount;
      }
    if (element.type === 'image' && ellipseFillInsets !== undefined) {
      // 椭圆裁剪走 shape + 图片填充：shape 的 geometry 就是填充的裁剪轮廓
      // （ellipse preset 在渲染器上落到 border-radius:50%，SVG 分支则是 clipPath），
      // 所以椭圆能真正渲染出来，而不是退化成外接矩形。代价是该元素在编辑器里是
      // 形状而非图片，图片专属控件（fit/滤镜）不可用。
      if (Object.keys(filters).length > 0)
        diagnostics.push({
          code: 'maic.image.ellipse_clip_filters_dropped',
          severity: 'warning',
          feature: 'image',
          message:
            'MAIC image filters are dropped when an elliptical clip is imported as a shape fill.',
          location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
        });
      diagnostics.push({
        code: 'maic.image.ellipse_clip_as_shape',
        severity: 'warning',
        feature: 'image',
        message:
          'Elliptical MAIC image clipping is imported as an ellipse shape with an image fill; the clip renders faithfully but image-only controls are unavailable.',
        location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
      });
      return {
        ...base,
        type: 'shape',
        geometry: { kind: 'preset', preset: 'ellipse' },
        style: {
          fill: { kind: 'image', resourceId, mode: 'stretch', insets: ellipseFillInsets },
        },
      };
    }
    return element.type === 'image'
      ? {
          ...base,
          type: 'image',
          resourceId,
          fit: 'stretch',
          alt: '',
          ...(crop ? { crop } : {}),
          ...(Object.keys(filters).length ? { filters } : {}),
        }
      : {
          ...base,
          type: 'audio',
          resourceId,
          playback: {
            startAt: 0,
            autoplay: boolean(source.autoplay),
            loop: boolean(source.loop),
            volume: 1,
          },
          title: 'Audio',
          ariaLabel: 'Audio',
        };
  }
  if (element.type === 'table') {
    const table = validateMaicTable(element, scaleX, scaleY);
    if (table === undefined) {
      diagnostics.push({
        code: 'maic.table.invalid',
        severity: 'error',
        feature: 'table',
        message: 'Table dimensions are inconsistent.',
        location: { pageId: page.id, sourceOrder: page.sourceOrder, elementId: element.id },
      });
      return undefined;
    }
    return {
      ...base,
      type: 'table',
      columnWidths: table.columnWidths,
      rowHeights: table.rowHeights,
      rows: table.data.map((row, rowIndex) => ({
        id: createStableMaicId('table-row', [
          options.applicationId,
          page.id,
          element.id,
          String(rowIndex),
        ]),
        cells: row.map(({ record, columnIndex }, cellIndex) => {
          return {
            id: createStableMaicId('table-cell', [
              options.applicationId,
              page.id,
              element.id,
              String(rowIndex),
              String(cellIndex),
            ]),
            rowSpan: positiveIntegerOrDefault(record.rowspan)!,
            columnSpan: positiveIntegerOrDefault(record.colspan)!,
            text: maicTableCellText(record, scaleX),
            style: {
              fill: maicTableCellFill(
                source,
                record,
                rowIndex,
                columnIndex,
                table.data.length,
                table.columnWidths.length,
              ),
              ...(isRecord(source.outline) ? { stroke: stroke(source.outline, scaleX) } : {}),
            },
          };
        }),
      })),
    };
  }
  return undefined;
};

// Only the bounded MAIC rich-text tags should switch a quiz field to HTML parsing.
// Generic parse5 element detection misclassifies ordinary comparisons such as `a<b`.
const MAIC_RICH_TEXT_TAG_PATTERN =
  /<\/?(?:p|div|h[1-6]|li|br|strong|b|em|i|u|s|del|sup|sub|span)(?:\s+[a-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?\s*>/i;

const quizRichText = (value: string) =>
  MAIC_RICH_TEXT_TAG_PATTERN.test(value) ? textFrame(value).doc : richTextFromPlainText(value);

const optionList = (value: unknown): QuizQuestionOption[] | undefined => {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const options = value.flatMap((entry, index) => {
    if (!isRecord(entry) || typeof entry.label !== 'string') return [];
    return [
      {
        value: typeof entry.value === 'string' && entry.value ? entry.value : String(index + 1),
        label: quizRichText(entry.label),
      },
    ];
  });
  return options.length >= 2 ? options : undefined;
};

const mapQuestion = (
  source: Readonly<Record<string, unknown>>,
  index: number,
  id: string,
): QuizQuestion | undefined => {
  const questionType = source.question_type;
  if (
    !['single_choice', 'multiple_choice', 'fill_in_the_blank', 'short_answer'].includes(
      String(questionType),
    ) ||
    typeof source.question !== 'string'
  )
    return undefined;
  const choice = questionType === 'single_choice' || questionType === 'multiple_choice';
  const fill = questionType === 'fill_in_the_blank';
  const options = choice ? optionList(source.options) : undefined;
  if (choice && !options) return undefined;
  const rawAnswers = Array.isArray(source.answer)
    ? source.answer.filter((entry): entry is string => typeof entry === 'string')
    : typeof source.answer === 'string'
      ? [source.answer]
      : [];
  const optionValues = new Set(options?.map((entry) => entry.value));
  const answers = choice ? rawAnswers.filter((entry) => optionValues.has(entry)) : rawAnswers;
  const blanks: QuizQuestionBlank[] | undefined = fill
    ? answers.map((answer, blankIndex) => ({
        blank_index: blankIndex + 1,
        id: `blank-${blankIndex + 1}`,
        answer: quizRichText(answer),
      }))
    : undefined;
  return {
    id,
    analysis: quizRichText(text(source.analysis)),
    analysis_attachments: [],
    answer: choice ? answers : quizRichText(fill ? '' : answers.join('\n')),
    ...(blanks ? { blanks } : {}),
    cognitive_schema: quizRichText(text(source.cognitive_schema)),
    has_answer: answers.length > 0,
    ...(options ? { options } : {}),
    points: 10,
    question: quizRichText(source.question),
    question_attachments: [],
    question_index: index,
    question_type: questionType as QuizQuestion['question_type'],
    sub_problems: [],
  };
};

export const mapMaicToReachDeckV2 = (
  ir: MaicCourseIR,
  options: MaicReachDeckV2MapperOptions,
): MaicReachDeckV2MappingResult => {
  const selected = options.includePageIds ? new Set(options.includePageIds) : undefined;
  if (
    selected &&
    (selected.size !== options.includePageIds?.length ||
      [...selected].some((id) => !ir.pages.some((page) => page.id === id)))
  ) {
    return {
      ok: false,
      schemaVersion: MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      diagnostics: [
        {
          code: 'maic.apply.invalid_page_selection',
          severity: 'fatal',
          feature: 'document',
          message: 'Selected MAIC page ids must be unique source page ids.',
        },
      ],
    };
  }
  const diagnostics: MaicDiagnostic[] = [];
  const pages: ReachDeckPublishedPage[] = [];
  const nativeSlides: Array<{ pageId: string; slide: ReachDeckNativeSlideV2 }> = [];
  const pageReports: MaicReachDeckV2PageReport[] = [];
  for (const sourcePage of ir.pages) {
    const pageDiagnostics: MaicDiagnostic[] = [];
    let mappedPage: ReachDeckPublishedPage | undefined;
    let nativeSlide: ReachDeckNativeSlideV2 | undefined;
    const pageId = createStableMaicId('page', [options.applicationId, sourcePage.id]);
    const title =
      sourcePage.kind === 'interactive' ? sourcePage.title : `Page ${sourcePage.sourceOrder}`;
    if (sourcePage.kind === 'canvas') {
      if (Math.abs(sourcePage.width / sourcePage.height - 16 / 9) > 0.001) {
        pageDiagnostics.push({
          code: 'maic.canvas.aspect_ratio',
          severity: 'warning',
          feature: 'canvas',
          message:
            'Source canvas aspect ratio differs from the native 16:9 stage; geometry is stretched and typography may differ.',
          location: { pageId: sourcePage.id, sourceOrder: sourcePage.sourceOrder },
        });
      }
      const background = mapCanvasBackground(ir, sourcePage, options);
      if (background.unresolved) {
        pageDiagnostics.push({
          code: 'maic.resource.unresolved',
          severity: 'error',
          feature: 'image',
          message: 'Referenced MAIC canvas background has not been promoted to managed storage.',
          location: {
            pageId: sourcePage.id,
            sourceOrder: sourcePage.sourceOrder,
            field: 'background',
          },
        });
      } else if (background.degraded) {
        pageDiagnostics.push({
          code: 'maic.canvas.background_degraded',
          severity: 'warning',
          feature: 'canvas',
          message: 'Unsupported or malformed MAIC canvas background uses white.',
          location: { pageId: sourcePage.id, sourceOrder: sourcePage.sourceOrder },
        });
      }
      let elements = sourcePage.elements.flatMap((element, index) => {
        const mapped = mapCanvasElement(ir, sourcePage, element, options, index, pageDiagnostics);
        return mapped ? [mapped] : [];
      });
      if (options.tableFontMetrics)
        elements = fitMaicTableRows(
          elements,
          sourcePage,
          options.tableFontMetrics,
          pageDiagnostics,
        );
      let narration: ReachDeckNativeSlideV2['narration'];
      if (sourcePage.script) {
        try {
          narration = {
            markdown: reachDeckNarrationMarkdownFromSegments([{ text: sourcePage.script }]),
          };
        } catch (error) {
          if (!(error instanceof ReachDeckNarrationMarkdownError)) throw error;
          pageDiagnostics.push({
            code: 'maic.narration.invalid',
            severity: 'error',
            feature: 'narration',
            message: error.message,
            location: {
              pageId: sourcePage.id,
              sourceOrder: sourcePage.sourceOrder,
              field: 'script',
            },
            details: { reason: error.code },
          });
        }
      }
      mappedPage = {
        pageId,
        order: 0,
        revision: 1,
        sceneType: 'slide',
        title,
      };
      nativeSlide = {
        schemaVersion: 'reach-deck-slide/v2',
        textCompatibility: 'native',
        id: createStableMaicId('native-slide', [options.applicationId, sourcePage.id]),
        title,
        background: background.fill,
        elements,
        animations: [],
        duration: REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
        ...(narration ? { narration } : {}),
      };
    } else if (sourcePage.kind === 'quiz') {
      const questions = sourcePage.questions.flatMap((question, index) => {
        const mapped = mapQuestion(
          question,
          index + 1,
          createStableMaicId('question', [options.applicationId, sourcePage.id, String(index + 1)]),
        );
        if (!mapped)
          pageDiagnostics.push({
            code: 'maic.quiz.question_unsupported',
            severity: 'error',
            feature: 'quiz',
            message: 'Quiz question cannot be mapped unambiguously.',
            location: {
              pageId: sourcePage.id,
              sourceOrder: sourcePage.sourceOrder,
              field: `questions[${index}]`,
            },
          });
        return mapped ? [mapped] : [];
      });
      if (questions.length > 0)
        mappedPage = {
          pageId,
          order: 0,
          revision: 1,
          sceneType: 'quiz',
          title,
          scene: {
            schemaVersion: 'reach-quiz-scene/v1',
            id: pageId,
            title,
            sceneType: 'quiz',
            content: {
              questions,
              display_mode: 'single_question',
              navigation: 'horizontal',
              show_progress: true,
              show_question_index: true,
              answer_reveal: 'after_submit',
              allow_previous: true,
              allow_skip: false,
            },
          },
        };
    } else if (sourcePage.transformedHtml) {
      mappedPage = {
        pageId,
        order: 0,
        revision: 1,
        sceneType: 'interactive',
        title,
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: pageId,
          title,
          sceneType: 'interactive',
          documentHtml: sourcePage.transformedHtml,
          bridgeVersion: 'reach-interactive-bridge/v1',
          ...(sourcePage.runtimeDependencies.length === 0
            ? {}
            : { runtimeDependencies: [...sourcePage.runtimeDependencies] }),
          runtimePolicy: {
            completionMode: 'none',
            allowReset: false,
            maximumDurationSeconds: null,
          },
          eventManifest: {
            schemaVersion: 'reach-interactive-event-manifest/v1',
            events: [],
          },
        },
      };
    } else
      pageDiagnostics.push({
        code: 'maic.interactive.unavailable',
        severity: 'error',
        feature: 'interactive',
        message: 'Interactive page did not pass offline conversion.',
        location: { pageId: sourcePage.id, sourceOrder: sourcePage.sourceOrder },
      });

    const hasError = pageDiagnostics.some(
      (entry) => entry.severity === 'error' || entry.severity === 'fatal',
    );
    const included = !hasError && mappedPage && (!selected || selected.has(sourcePage.id));
    if (included && mappedPage) {
      mappedPage.order = pages.length + 1;
      pages.push(mappedPage);
      if (nativeSlide) nativeSlides.push({ pageId, slide: nativeSlide });
    }
    diagnostics.push(...pageDiagnostics);
    pageReports.push({
      pageId: sourcePage.id,
      mappedPageId: included ? pageId : undefined,
      sourceOrder: sourcePage.sourceOrder,
      kind: sourcePage.kind,
      status: hasError
        ? 'error'
        : pageDiagnostics.some((entry) => entry.severity === 'warning')
          ? 'warning'
          : 'ok',
      diagnostics: pageDiagnostics,
    });
  }
  if (pages.length === 0)
    return {
      ok: false,
      schemaVersion: MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      diagnostics: [
        ...diagnostics,
        {
          code: 'maic.mapping.empty',
          severity: 'fatal',
          feature: 'document',
          message: 'No MAIC pages were selected for import.',
        },
      ],
    };
  const themeId = createStableMaicId('theme', [options.applicationId, 'compatibility']);
  const referencedMedia = new Set(
    nativeSlides.flatMap(({ slide }) => [
      ...(slide.background.kind === 'image' ? [slide.background.resourceId] : []),
      ...slide.elements.flatMap((element) => {
        if (element.type === 'image' || element.type === 'audio') return [element.resourceId];
        if (
          (element.type === 'shape' || element.type === 'textFrame') &&
          element.style?.fill?.kind === 'image'
        )
          return [element.style.fill.resourceId];
        return [];
      }),
    ]),
  );
  const media = ir.mediaReferences.flatMap((reference) => {
    const resolved = options.media?.[reference.id];
    const id = createStableMaicId('media', [options.applicationId, reference.id]);
    return resolved && referencedMedia.has(id) ? [{ id, ...resolved }] : [];
  });
  const theme = options.compatibilityTheme;
  try {
    const document = parseReachDeckDocumentV2({
      schemaVersion: 'reach-deck-document/v2',
      id: options.documentId,
      title: options.title,
      stage: { width: 1600, height: 900, aspectRatio: '16:9' },
      theme,
      defaultThemeId: themeId,
      resources: {
        themes: [
          {
            id: themeId,
            name: theme.name,
            colors: {
              background: theme.background,
              surface: theme.surface,
              ink: theme.ink,
              muted: theme.muted,
              accent: theme.accent,
              success: theme.success,
              warning: theme.warning,
            },
            fonts: { display: theme.fontDisplay, body: theme.fontBody },
          },
        ],
        masters: [],
        layouts: [],
        media,
      },
      metadata: {
        source: 'import',
        language: options.language,
        generatedAt: options.generatedAt,
        contentDigest: `draft:maic:${ir.sourceDigest}:${options.applicationId}`,
      },
      provenance: {
        source: 'maic',
        sourceDigest: ir.sourceDigest,
        importerVersion: MAIC_IMPORTER_VERSION,
      },
      revisions: [],
      pages,
      nativeSlides,
    });
    return {
      ok: true,
      schemaVersion: MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      document,
      pageReports,
      diagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      schemaVersion: MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      diagnostics: [
        ...diagnostics,
        {
          code: 'maic.mapping.invalid_document',
          severity: 'fatal',
          feature: 'document',
          message:
            error instanceof Error ? error.message : 'Mapped Reach Deck document is invalid.',
        },
      ],
    };
  }
};
