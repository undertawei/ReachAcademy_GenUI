import type { ReachDeckTableElementV2, RichTextNode } from '@reachany/reach-deck-dsl';
import { HtmlLayoutValidationError, type ReportLayoutDiagnostic } from './types';

export const HTML_REFERENCE_LAYOUT_VERSION = 'html-reference-layout/v19';
export const HTML_REFERENCE_LAYOUT_PROMPT = `Reference layout adapter ${HTML_REFERENCE_LAYOUT_VERSION}:
NATIVE TABLES
- Teaching tables use semantic TABLE directly under section#slide, with complete inline geometry. Preserve header/merge relationships with TH and colspan/rowspan; one table has one narration reveal anchor. Never put a table in a figure or rasterize its content.
- Inside TABLE use THEAD/TBODY/TFOOT/TR/TH/TD and plain inline cell text (SPAN, STRONG/B, EM/I, S, BR; never U or underline, which is dropped); no CAPTION, COLGROUP/COL, nested TABLE, IMG, SVG, FIGURE or block cell content. Put captions in separate editable slide-level text and column widths on TH/TD.
- Set border-collapse:collapse;background-image:none;transform:none;filter:none;box-shadow:none. TABLE/TH/TD use solid background-color; write each cell's color, background, padding and uniform solid borders (or no borders) explicitly on TH/TD. Descendants also have transform:none;filter:none;box-shadow:none;opacity:1. Keep decorative gradients and shadows outside the table.
- Table readability guideline: about 6 columns and 8 rows (header included), 48 grid positions per page, 240 Unicode codepoints per cell and 2400 table text codepoints per page. These are guidelines, not hard limits. Keep the source table's structure and orientation (never transpose fields into rows) whenever it fits the page with readable text that stays inside every cell. Only when it would not fit, combine adjacent, closely related fields into one column whose header names both, written as "Field A／Field B". This preserves the supplied facts and is not a rewrite of the lesson; never drop or rename a supplied field.
- The page allows 40 top-level editable text elements and 80 native elements; these are resource limits, not density targets. Table cells do not consume the top-level text budget.
INFORMATIVE COLOR
- Text must contrast with its actual local background: normal/small text at least 4.5:1; large text (24px regular or 18.67px bold) at least 3:1. Check composited colors over photos, gradients and transparency; palette membership is not proof of readability.
- Use data-reach-informative="true" only on empty solid primitive shapes whose color carries information, not images, trusted slots, figures, groups or background/text carriers. Their informative contrast must be at least 3:1. Mark heatmap tables with data-reach-heatmap; distinct adjacent heatmap colors also need 3:1.`;

const fail = (id: string, reason: string): never => {
  throw new HtmlLayoutValidationError(
    `NATIVE_TABLE: ${id.slice(0, 160)}: ${reason}`.slice(0, 1800),
  );
};
const color = (document: Document, value: string) => {
  const context = document.createElement('canvas').getContext('2d')!;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return {
    kind: 'srgb' as const,
    value: `#${[r, g, b].map((n) => n!.toString(16).padStart(2, '0')).join('')}`,
    ...(a! < 255 ? { alpha: a! / 255 } : {}),
  };
};

function cellBackground(document: Document, cell: Element, root: HTMLElement) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const ancestors: Element[] = [];
  for (
    let current: Element | null = cell;
    current && current !== root;
    current = current.parentElement
  )
    ancestors.unshift(current);
  for (const ancestor of ancestors) {
    const style = document.defaultView!.getComputedStyle(ancestor);
    if (style.backgroundImage !== 'none') fail(cell.id, 'table backgrounds must be solid');
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
  }
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return {
    kind: 'srgb' as const,
    value: `#${[r, g, b].map((n) => n!.toString(16).padStart(2, '0')).join('')}`,
    ...(a! < 255 ? { alpha: a! / 255 } : {}),
  };
}

const MAX_TABLE_ROWS = 8;
const MAX_TABLE_COLUMNS = 6;
const MAX_PAGE_GRID = 48;
const MAX_CELL_TEXT = 240;
const MAX_PAGE_TABLE_TEXT = 2400;

type InkRects = (
  document: Document,
  element: Element,
) => Array<Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>>;

/** Logical grid; spans past the last row are clipped so structural errors are left to extraction. */
function tableGrid(table: HTMLTableElement) {
  const rows = Array.from(table.rows);
  const occupied: (HTMLTableCellElement | undefined)[][] = rows.map(() => []);
  const placements: { cell: HTMLTableCellElement; row: number; column: number }[] = [];
  rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      while (occupied[rowIndex]![column]) column++;
      placements.push({ cell, row: rowIndex, column });
      const rowEnd = Math.min(rows.length, rowIndex + Math.max(1, cell.rowSpan));
      for (let r = rowIndex; r < rowEnd; r++)
        for (let c = column; c < column + cell.colSpan; c++) occupied[r]![c] ??= cell;
      column += cell.colSpan;
    }
  });
  return { rows, occupied, placements, columns: Math.max(0, ...occupied.map((row) => row.length)) };
}

function cellContentBox(view: Window, cell: Element) {
  const style = view.getComputedStyle(cell);
  const rect = cell.getBoundingClientRect();
  return {
    left: rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) / 2,
    right: rect.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) / 2,
    top: rect.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth) / 2,
    bottom: rect.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth) / 2,
  };
}

/** Browser-measured fit: the table stays on the slide and every cell's text stays in its content box. */
function tableFitsSlide(
  document: Document,
  table: HTMLTableElement,
  root: HTMLElement,
  inkRects: InkRects,
): boolean {
  const box = table.getBoundingClientRect();
  const rootBox = root.getBoundingClientRect();
  if (
    box.left < rootBox.left - 1 ||
    box.top < rootBox.top - 1 ||
    box.right > rootBox.right + 1 ||
    box.bottom > rootBox.bottom + 1
  )
    return false;
  return Array.from(table.querySelectorAll('td,th')).every((cell) => {
    const content = cellContentBox(document.defaultView!, cell);
    return inkRects(document, cell).every(
      (r) =>
        r.left >= content.left - 1 &&
        r.right <= content.right + 1 &&
        r.top >= content.top - 1 &&
        r.bottom <= content.bottom + 1,
    );
  });
}

/** Moves inline content; headers join with "／", data cells continue on a new line. */
function appendCellContent(target: HTMLTableCellElement, source: HTMLTableCellElement): void {
  if (!source.textContent?.trim()) return;
  if (target.textContent?.trim())
    target.append(target.tagName === 'TH' ? '／' : target.ownerDocument.createElement('br'));
  target.append(...Array.from(source.childNodes));
}

/**
 * Folds cells beyond the budget into the last allowed column (or row). Targets are resolved before
 * any mutation; when a cell has no target in its row/column the table is left untouched, so content
 * is never dropped.
 */
function mergeTableOverflow(table: HTMLTableElement, axis: 'column' | 'row'): boolean {
  const { rows, occupied, placements } = tableGrid(table);
  const limit = axis === 'column' ? MAX_TABLE_COLUMNS : MAX_TABLE_ROWS;
  const moves: { cell: HTMLTableCellElement; target: HTMLTableCellElement }[] = [];
  for (const { cell, row, column } of placements) {
    if ((axis === 'column' ? column : row) < limit) continue;
    const line =
      axis === 'column'
        ? occupied[row]!.slice(0, limit)
        : occupied.slice(0, limit).map((cells) => cells[column]);
    const target = line.reverse().find((candidate) => candidate !== undefined);
    if (!target) return false;
    moves.push({ cell, target });
  }
  for (const { cell, target } of moves) {
    appendCellContent(target, cell);
    cell.remove();
  }
  for (const { cell, row, column } of placements) {
    if (!cell.isConnected) continue;
    if (axis === 'column' && column + cell.colSpan > limit) cell.colSpan = limit - column;
    if (axis === 'row' && cell.rowSpan > 0 && row + cell.rowSpan > limit)
      cell.rowSpan = limit - row;
  }
  if (axis === 'row') rows.slice(limit).forEach((row) => row.remove());
  return true;
}

/**
 * Over-budget tables are kept when the browser measures them on the slide with every cell's text
 * inside its content box; otherwise overflow is merged into the last column/row and re-measured.
 */
function normalizeOverBudgetTable(
  document: Document,
  table: HTMLTableElement,
  root: HTMLElement,
  inkRects: InkRects,
  report: ReportLayoutDiagnostic,
): void {
  const before = tableGrid(table);
  if (before.rows.length <= MAX_TABLE_ROWS && before.columns <= MAX_TABLE_COLUMNS) return;
  const shape = `${before.rows.length}x${before.columns}`;
  const budget = `${MAX_TABLE_ROWS}x${MAX_TABLE_COLUMNS}`;
  if (tableFitsSlide(document, table, root, inkRects)) {
    report(
      table.id,
      `NATIVE_TABLE: ${table.id}: ${shape} grid exceeds the ${budget} budget; kept because it fits the slide`,
    );
    return;
  }
  const columnsMerged = before.columns <= MAX_TABLE_COLUMNS || mergeTableOverflow(table, 'column');
  const rowsMerged = before.rows.length <= MAX_TABLE_ROWS || mergeTableOverflow(table, 'row');
  const merged = columnsMerged && rowsMerged;
  const after = tableGrid(table);
  report(
    table.id,
    merged
      ? `NATIVE_TABLE: ${table.id}: ${shape} grid exceeds the ${budget} budget and does not fit; merged overflow into the last column/row (now ${after.rows.length}x${after.columns})`
      : `NATIVE_TABLE: ${table.id}: ${shape} grid exceeds the ${budget} budget and does not fit; some overflow has no merge target and was kept`,
  );
}

/** Extract before the preserved core can classify any table subtree as a raster. */
export function extractReferenceTables(
  document: Document,
  root: HTMLElement,
  inkRects: InkRects,
  report: ReportLayoutDiagnostic,
): Map<string, ReachDeckTableElementV2> {
  const result = new Map<string, ReachDeckTableElementV2>();
  let gridBudget = 0;
  let textBudget = 0;
  const view = document.defaultView!;
  const rootBox = root.getBoundingClientRect();
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const id = table.id;
    if (table.parentElement !== root)
      fail(
        id || `${table.parentElement?.closest('[id]')?.id || root.id || 'slide'}/table`,
        'tables must be direct slide children; nested tables and figure tables cannot be rasterized',
      );
    const unsupported = table.querySelector('table,img,svg,figure,caption,colgroup');
    if (unsupported) {
      const tag = unsupported.tagName.toLowerCase();
      fail(
        id,
        `unsupported table descendant <${tag}>. Remove it: put captions in separate editable slide-level text, set column widths on TH/TD, and keep images/graphics outside the table. Cells support plain inline text only.`,
      );
    }
    // Native tables carry no shadow; a decorative one is dropped instead of failing the page.
    const shadowed = [table, ...Array.from(table.querySelectorAll('*'))].filter(
      (node) => view.getComputedStyle(node).boxShadow !== 'none',
    ) as HTMLElement[];
    for (const node of shadowed) node.style.setProperty('box-shadow', 'none', 'important');
    if (shadowed.length)
      report(
        id,
        `NATIVE_TABLE: ${id}: decorative box-shadow dropped; native tables have no shadow`,
      );
    for (const node of [table, ...Array.from(table.querySelectorAll('*'))]) {
      const s = view.getComputedStyle(node);
      if (
        s.transform !== 'none' ||
        s.filter !== 'none' ||
        s.visibility !== 'visible' ||
        s.display === 'none' ||
        Number(s.opacity) !== 1 ||
        s.clipPath !== 'none' ||
        s.maskImage !== 'none' ||
        s.boxShadow !== 'none'
      )
        fail(id, 'table descendants must use visible untransformed native styles');
      if (
        s.writingMode !== 'horizontal-tb' ||
        parseFloat(s.textIndent) !== 0 ||
        s.textShadow !== 'none'
      )
        fail(id, 'unsupported table text orientation, indent or shadow');
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const bounds = node.getBoundingClientRect();
        if (
          inkRects(document, node).some(
            (rect) =>
              (s.overflowX !== 'visible' &&
                (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) ||
              (s.overflowY !== 'visible' &&
                (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)),
          )
        )
          report(id, `NATIVE_TABLE: ${id}: table text is clipped by a nested text element`);
      }
      for (const pseudo of ['::before', '::after']) {
        if (!['none', 'normal', '""'].includes(view.getComputedStyle(node, pseudo).content))
          fail(id, 'generated pseudo text is unsupported');
      }
    }
    normalizeOverBudgetTable(document, table, root, inkRects, report);
    // Text budgets are readability targets; overflow itself is measured per cell below.
    const pageTextBefore = textBudget;
    for (const cell of Array.from(table.querySelectorAll('td,th'))) {
      const count = Array.from(cell.textContent ?? '').length;
      textBudget += count;
      if (count > MAX_CELL_TEXT)
        report(id, `NATIVE_TABLE: ${id}: a cell exceeds ${MAX_CELL_TEXT} Unicode codepoints`);
    }
    if (pageTextBefore <= MAX_PAGE_TABLE_TEXT && textBudget > MAX_PAGE_TABLE_TEXT)
      report(
        id,
        `NATIVE_TABLE: ${id}: page table text exceeds ${MAX_PAGE_TABLE_TEXT} Unicode codepoints`,
      );
    const box = table.getBoundingClientRect();
    const tableStyle = view.getComputedStyle(table);
    if (
      tableStyle.transform !== 'none' ||
      tableStyle.filter !== 'none' ||
      tableStyle.backgroundImage !== 'none' ||
      tableStyle.borderCollapse !== 'collapse'
    )
      fail(
        id,
        `use border-collapse:collapse without transforms or complex backgrounds; invalid properties: ${[
          tableStyle.transform !== 'none' ? 'transform' : '',
          tableStyle.filter !== 'none' ? 'filter' : '',
          tableStyle.backgroundImage !== 'none' ? 'background-image' : '',
          tableStyle.borderCollapse !== 'collapse' ? 'border-collapse' : '',
        ]
          .filter(Boolean)
          .join(', ')}`,
      );
    if (
      box.left < rootBox.left ||
      box.top < rootBox.top ||
      box.right > rootBox.right ||
      box.bottom > rootBox.bottom
    )
      report(id, `NATIVE_TABLE: ${id}: table extends outside the slide`);
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0
    )
      fail(id, 'table requires finite positive geometry');
    const rows = Array.from(table.rows);
    if (!rows.length) fail(id, 'table requires at least one row');
    const occupied: boolean[][] = rows.map(() => []);
    const xEdges = new Map<number, number>([[0, box.left]]);
    let columns = 0;
    const nativeRows = rows.map((row, rowIndex) => {
      let column = 0;
      const cells = Array.from(row.cells).map((cell, cellIndex) => {
        while (occupied[rowIndex]![column]) column++;
        const rowSpan = cell.rowSpan;
        const columnSpan = cell.colSpan;
        if (!rowSpan || rowIndex + rowSpan > rows.length) fail(id, 'invalid row merge');
        for (let r = rowIndex; r < rowIndex + rowSpan; r++)
          for (let c = column; c < column + columnSpan; c++) {
            if (occupied[r]![c]) fail(id, 'overlapping cell spans');
            occupied[r]![c] = true;
          }
        const style = view.getComputedStyle(cell);
        const borders = ['Top', 'Right', 'Bottom', 'Left'].map((side) => {
          const key = side as 'Top' | 'Right' | 'Bottom' | 'Left';
          return `${style[`border${key}Width`]} ${style[`border${key}Style`]} ${style[`border${key}Color`]}`;
        });
        if (new Set(borders).size > 1 || !['none', 'solid'].includes(style.borderTopStyle))
          fail(id, 'native cells support uniform solid borders');
        if (
          cell.querySelector('div,p,h1,h2,h3,ul,ol') ||
          style.transform !== 'none' ||
          style.backgroundImage !== 'none' ||
          style.filter !== 'none' ||
          style.visibility !== 'visible' ||
          Number(style.opacity) !== 1
        )
          fail(id, 'cell supports visible inline text and solid fills only');
        const rect = cell.getBoundingClientRect();
        xEdges.set(column, rect.left);
        xEdges.set(column + columnSpan, rect.right);
        const contentBox = cellContentBox(view, cell);
        const ink = inkRects(document, cell);
        if (
          ink.some(
            (r) =>
              r.left < contentBox.left - 1 ||
              r.right > contentBox.right + 1 ||
              r.top < contentBox.top - 1 ||
              r.bottom > contentBox.bottom + 1,
          )
        )
          report(
            id,
            `NATIVE_TABLE: ${id}: cell ${rowIndex + 1}:${column + 1} text exceeds its content box`,
          );
        for (const rect of ink) {
          const top = document.elementFromPoint(
            (rect.left + rect.right) / 2,
            (rect.top + rect.bottom) / 2,
          );
          if (top && !cell.contains(top) && !top.contains(cell))
            report(
              id,
              `NATIVE_TABLE: ${id}: cell ${rowIndex + 1}:${column + 1} text is obscured by another element`,
            );
        }
        for (let ancestor: Element | null = cell; ancestor; ancestor = ancestor.parentElement) {
          const s = view.getComputedStyle(ancestor);
          const b = ancestor.getBoundingClientRect();
          if (
            ink.some(
              (r) =>
                (s.overflowX !== 'visible' && (r.left < b.left - 1 || r.right > b.right + 1)) ||
                (s.overflowY !== 'visible' && (r.top < b.top - 1 || r.bottom > b.bottom + 1)),
            )
          )
            report(id, `NATIVE_TABLE: ${id}: cell ${rowIndex + 1}:${column + 1} text is clipped`);
        }
        const nodes: RichTextNode[] = [];
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE && node.textContent) {
            const s = view.getComputedStyle(node.parentElement!);
            if (s.visibility !== 'visible' || s.display === 'none')
              fail(id, 'hidden cell text is unsupported');
            // text-decoration does not inherit in computed style; font runs wrap the text in spans.
            let underlined = false;
            for (
              let owner: Element | null = node.parentElement;
              owner && !underlined;
              owner = owner === cell ? null : owner.parentElement
            )
              underlined = view.getComputedStyle(owner).textDecorationLine.includes('underline');
            if (underlined)
              report(
                id,
                `NATIVE_TABLE: ${id}: cell ${rowIndex + 1}:${column + 1} underline dropped; generated text is never underlined`,
              );
            nodes.push({
              type: 'text',
              text:
                s.textTransform === 'uppercase'
                  ? node.textContent.toUpperCase()
                  : s.textTransform === 'lowercase'
                    ? node.textContent.toLowerCase()
                    : node.textContent,
              marks: [
                {
                  type: 'textStyle',
                  attrs: {
                    color: s.color,
                    fontFamily: s.fontFamily.split(',')[0]!.replace(/["']/g, ''),
                    fontSize: s.fontSize,
                    fontWeight: Number(s.fontWeight) || 400,
                  },
                },
                ...(s.fontStyle === 'italic' ? [{ type: 'italic' }] : []),
                ...(s.textDecorationLine.includes('line-through') ? [{ type: 'strike' }] : []),
              ],
            });
          } else if (node.nodeName === 'BR') nodes.push({ type: 'hardBreak' });
          else for (const child of Array.from(node.childNodes)) walk(child);
        };
        walk(cell);
        column += columnSpan;
        columns = Math.max(columns, column);
        return {
          id: cell.id || `${id}-r${rowIndex + 1}-c${cellIndex + 1}`,
          rowSpan,
          columnSpan,
          ...(cell.tagName === 'TH' ? { header: true } : {}),
          text: {
            margins: {
              left: parseFloat(style.paddingLeft),
              right: parseFloat(style.paddingRight),
              top: parseFloat(style.paddingTop),
              bottom: parseFloat(style.paddingBottom),
            },
            verticalAlignment: (style.verticalAlign === 'middle' || style.verticalAlign === 'bottom'
              ? style.verticalAlign
              : 'top') as 'top' | 'middle' | 'bottom',
            wrap: style.whiteSpace !== 'nowrap',
            autofit: { mode: 'none' as const },
            fontSubstitutions: [],
            doc: {
              type: 'doc' as const,
              content: [
                {
                  type: 'paragraph',
                  attrs: {
                    textAlign: ['left', 'center', 'right', 'justify'].includes(style.textAlign)
                      ? style.textAlign
                      : 'left',
                    ...(parseFloat(style.lineHeight)
                      ? { lineHeightPx: parseFloat(style.lineHeight) }
                      : {}),
                  },
                  content: nodes,
                },
              ],
            },
          },
          style: {
            fill: { kind: 'solid' as const, color: cellBackground(document, cell, root) },
            ...(parseFloat(style.borderTopWidth) > 0
              ? {
                  stroke: {
                    width: parseFloat(style.borderTopWidth),
                    fill: color(document, style.borderTopColor),
                  },
                }
              : {}),
          },
        };
      });
      return { id: `${id}-row-${rowIndex + 1}`, cells };
    });
    const gridBefore = gridBudget;
    gridBudget += rows.length * columns;
    if (gridBefore <= MAX_PAGE_GRID && gridBudget > MAX_PAGE_GRID)
      report(id, `NATIVE_TABLE: ${id}: page grid exceeds ${MAX_PAGE_GRID} positions`);
    if (
      !columns ||
      occupied.some((row) => Array.from({ length: columns }, (_, c) => row[c]).some((v) => !v))
    )
      fail(id, 'table grid has holes');
    if (Array.from({ length: columns + 1 }, (_, c) => xEdges.has(c)).some((v) => !v))
      fail(id, 'merged grid needs at least one measurable edge per column');
    result.set(id, {
      id,
      type: 'table',
      zIndex: Number(tableStyle.zIndex) || 0,
      transform: {
        x: box.left - rootBox.left,
        y: box.top - rootBox.top,
        width: box.width,
        height: box.height,
      },
      columnWidths: Array.from({ length: columns }, (_, c) => xEdges.get(c + 1)! - xEdges.get(c)!),
      rowHeights: rows.map((row) => row.getBoundingClientRect().height),
      rows: nativeRows,
    });
  }
  return result;
}

export function installTablePlaceholders(
  document: Document,
  tables: ReadonlyMap<string, ReachDeckTableElementV2>,
): void {
  for (const [id, table] of tables) {
    const placeholder = document.createElement('div');
    placeholder.id = id;
    const { x, y, width, height } = table.transform;
    placeholder.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;background:#ffffff;z-index:${table.zIndex}`;
    document.getElementById(id)!.replaceWith(placeholder);
  }
}
