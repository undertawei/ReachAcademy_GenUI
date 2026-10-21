import type { ReachDeckFillV2 } from '@reachany/reach-deck-dsl';
import { maicColor, maicCssColor } from './style.js';
import { maicTextFrame } from './text.js';

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function maicTableCellFill(
  source: Readonly<Record<string, unknown>>,
  cell: Readonly<Record<string, unknown>>,
  row: number,
  column: number,
  rowCount: number,
  columnCount: number,
): ReachDeckFillV2 {
  const theme = record(source.theme);
  const themeColor = maicCssColor(theme.color);
  const backcolor = record(cell.style).backcolor;
  const explicitColor = maicCssColor(backcolor);
  let color = maicColor(explicitColor ? backcolor : themeColor ? theme.color : '#FFFFFF');
  if (color.kind !== 'srgb') return { kind: 'solid', color };
  if (themeColor) {
    if (!explicitColor) {
      const headerOrFooter =
        (theme.rowHeader === true && row === 0) ||
        (theme.rowFooter === true && row === rowCount - 1) ||
        (theme.colHeader === true && column === 0) ||
        (theme.colFooter === true && column === columnCount - 1);
      if (!headerOrFooter) color = { ...color, alpha: row % 2 === 0 ? 0.1 : 0.3 };
    }
    // PPTist paints the complete themed table over white, even on colored slides.
    const alpha = color.alpha ?? 1;
    const value = color.value;
    color = {
      kind: 'srgb',
      value: `#${[1, 3, 5]
        .map((index) =>
          Math.round(Number.parseInt(value.slice(index, index + 2), 16) * alpha + 255 * (1 - alpha))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
        .toUpperCase()}`,
    };
  }
  return { kind: 'solid', color };
}

export function maicTableCellText(cell: Readonly<Record<string, unknown>>, scale: number) {
  const style = record(cell.style);
  const size =
    typeof style.fontsize === 'string' && /^\d+(?:\.\d+)?px$/.test(style.fontsize.trim())
      ? Number.parseFloat(style.fontsize)
      : undefined;
  return maicTextFrame(
    typeof cell.text === 'string' ? cell.text : '',
    {
      ...style,
      defaultColor: maicCssColor(style.color) ?? maicCssColor(style.defaultColor) ?? '#000000',
      fontSize:
        size !== undefined && Number.isFinite(size) && size > 0
          ? size
          : typeof style.fontSize === 'number' &&
              Number.isFinite(style.fontSize) &&
              style.fontSize > 0
            ? style.fontSize
            : 14,
      defaultFontName: typeof style.fontname === 'string' ? style.fontname : style.defaultFontName,
      textAlign: style.align,
      align: undefined,
      vAlign: style.vAlign === 'top' || style.vAlign === 'bottom' ? style.vAlign : 'middle',
      padding: 5,
      lineHeight: 1.5,
    },
    scale,
  );
}
