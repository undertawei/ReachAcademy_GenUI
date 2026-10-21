import { describe, expect, it } from 'vitest';
import type { ReachDeckTableCellV2 } from '@reachany/reach-deck-dsl';
import { mapMaicToReachDeckV2, parseMaicCourse } from '../src/maic/index.js';

const cell = (text = 'Cell', style: Record<string, unknown> = {}) => ({
  text,
  colspan: 1,
  rowspan: 1,
  style,
});

function mapTable(overrides: Record<string, unknown> = {}) {
  const parsed = parseMaicCourse(
    JSON.stringify({
      title: 'Synthetic table',
      width: 1000,
      height: 562.5,
      slides: [
        {
          id: 'page',
          component_type: 'canvas',
          canvas_width: 1000,
          canvas_height: 562.5,
          background: { type: 'solid', color: '#123456' },
          elements: [
            {
              id: 'table',
              type: 'table',
              left: 60,
              top: 100,
              width: 880,
              height: 180,
              colWidths: [0.15, 0.3, 0.55],
              cellMinHeight: 36,
              outline: { width: 1, style: 'solid', color: '#eeece1' },
              theme: { color: '#5b9bd5', rowHeader: true },
              data: Array.from({ length: 4 }, (_, row) =>
                Array.from({ length: 3 }, () =>
                  cell('Example', {
                    fontsize: '21.33px',
                    align: 'center',
                    color: row === 0 ? '#ffffff' : '#000000',
                    bold: row === 0,
                  }),
                ),
              ),
              ...overrides,
            },
          ],
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const mapped = mapMaicToReachDeckV2(parsed.ir, {
    documentId: 'table-fixture',
    applicationId: 'table-fixture',
    title: 'Synthetic table',
    language: 'en-US',
    generatedAt: '2026-09-19T00:00:00Z',
    compatibilityTheme: {
      name: 'Fixture',
      background: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#000000',
      muted: '#666666',
      accent: '#FF0000',
      success: '#008000',
      warning: '#FF8800',
      fontDisplay: 'Noto Sans',
      fontBody: 'Noto Sans',
    },
  });
  if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
  const table = mapped.document.nativeSlides[0]?.slide.elements[0];
  if (table?.type !== 'table') throw new Error(JSON.stringify(mapped.diagnostics));
  return table;
}

const fill = (value: string, alpha?: number) => ({
  kind: 'solid',
  color: { kind: 'srgb', value, ...(alpha === undefined ? {} : { alpha }) },
});
const runs = (value: ReachDeckTableCellV2) => value.text.doc.content![0]!.content!;
const textStyle = (value: ReachDeckTableCellV2, index = 0) =>
  runs(value)[index]!.marks!.find((mark) => mark.type === 'textStyle')!.attrs;

describe('MAIC table fidelity', () => {
  it('maps a source-shaped blue table with opaque theme bands, outlines and scaled cell text', () => {
    const table = mapTable();
    expect(table.rows.map((row) => row.cells[0]!.style.fill)).toEqual([
      fill('#5B9BD5'),
      fill('#CEE1F2'),
      fill('#EFF5FB'),
      fill('#CEE1F2'),
    ]);
    for (const row of table.rows) {
      for (const value of row.cells) {
        expect(value.style.stroke).toMatchObject({
          width: 1.6,
          fill: { kind: 'srgb', value: '#EEECE1' },
          dash: 'solid',
        });
        expect(value.text.margins).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
        expect(value.text.verticalAlignment).toBe('middle');
        expect(value.text.doc.content![0]!.attrs).toMatchObject({
          textAlign: 'center',
          lineHeight: 1.5,
          fontSize: 34.128,
        });
        expect(textStyle(value)?.fontSize).toBe('34.128px');
      }
    }
    expect(textStyle(table.rows[0]!.cells[0]!)).toMatchObject({ color: '#FFFFFF' });
    expect(runs(table.rows[0]!.cells[0]!)[0]!.marks).toContainEqual({ type: 'bold' });
    expect(runs(table.rows[1]!.cells[0]!)[0]!.marks).not.toContainEqual({ type: 'bold' });
  });

  it('lets explicit backgrounds override header and band fills, compositing theme transparency over white', () => {
    const table = mapTable({
      data: [
        [
          cell('a', { backcolor: '#FF0000' }),
          cell('b', { backcolor: 'rgba(255,0,0,0.5)' }),
          cell('c', { backcolor: 'transparent' }),
        ],
        [cell(), cell(), cell()],
      ],
    });
    expect(table.rows[0]!.cells.map((value) => value.style.fill)).toEqual([
      fill('#FF0000'),
      fill('#FF8080'),
      fill('#FFFFFF'),
    ]);
  });

  it('maps cell typography and alignment while allowing inline HTML to reset defaults', () => {
    const table = mapTable({
      data: [
        [
          cell('Styled', {
            bold: true,
            em: true,
            underline: true,
            strikethrough: true,
            fontsize: '20px',
            fontname: 'KaiTi',
            align: 'right',
            vAlign: 'middle',
            color: '#123456',
          }),
          cell(
            '<p style="text-align:left"><span style="font-weight:normal;font-style:normal;text-decoration:none;color:#abcdef;font-size:10px;font-family:serif">Reset</span>Inherited</p>',
            {
              bold: true,
              em: true,
              underline: true,
              strikethrough: true,
              fontsize: '20px',
              align: 'right',
              vAlign: 'bottom',
            },
          ),
          cell(
            '<strong><em>nested<span style="font-weight:400;font-style:normal">normal</span></em></strong>',
          ),
        ],
      ],
    });
    const [styled, reset, nested] = table.rows[0]!.cells;
    expect(styled!.text.verticalAlignment).toBe('middle');
    expect(styled!.text.doc.content![0]!.attrs?.textAlign).toBe('right');
    expect(runs(styled!)[0]!.marks).toEqual(
      expect.arrayContaining([
        { type: 'bold' },
        { type: 'italic' },
        { type: 'underline' },
        { type: 'strike' },
      ]),
    );
    expect(textStyle(styled!)).toMatchObject({
      color: '#123456',
      fontSize: '32px',
      fontFamily: 'LXGW WenKai',
    });
    expect(reset!.text.verticalAlignment).toBe('bottom');
    expect(reset!.text.doc.content![0]!.attrs?.textAlign).toBe('left');
    expect(runs(reset!)[0]!.marks).toEqual([
      {
        type: 'textStyle',
        attrs: expect.objectContaining({
          color: '#ABCDEF',
          fontSize: '16px',
          fontFamily: 'Source Han Serif SC',
        }),
      },
    ]);
    expect(runs(reset!)[1]!.marks).toEqual(
      expect.arrayContaining([
        { type: 'bold' },
        { type: 'italic' },
        { type: 'underline' },
        { type: 'strike' },
      ]),
    );
    expect(runs(nested!)[1]!.marks).toEqual([
      { type: 'textStyle', attrs: expect.objectContaining({ fontWeight: 400 }) },
    ]);
  });

  it('rejects malformed cell styles without injecting HTML or CSS and retains generic font defaults', () => {
    const table = mapTable({
      theme: { color: 'url(https://invalid)' },
      data: [
        [
          cell('<script>secret</script><p>Visible</p>', {
            color: '#12345',
            fontsize: '999999999999999999999999e9px',
            fontname: '\" onclick=\"secret',
            backcolor: 'url(https://invalid)',
          }),
          cell('Fallback', {
            defaultColor: '#654321',
            fontSize: 18,
            fontsize: '-5px',
            vAlign: 'top',
          }),
          cell('Finite', { fontsize: `${'9'.repeat(400)}px`, align: 'invalid', vAlign: 'invalid' }),
        ],
      ],
    });
    const [malformed, generic, finite] = table.rows[0]!.cells;
    expect(malformed!.style.fill).toEqual(fill('#FFFFFF'));
    expect(textStyle(malformed!)?.color).toBe('#000000');
    expect(Number.parseFloat(String(textStyle(malformed!)?.fontSize))).toBeCloseTo(22.4);
    expect(textStyle(generic!)).toMatchObject({ color: '#654321', fontSize: '28.8px' });
    expect(generic!.text.verticalAlignment).toBe('top');
    expect(Number.parseFloat(String(textStyle(finite!)?.fontSize))).toBeCloseTo(22.4);
    expect(finite!.text.doc.content![0]!.attrs).not.toHaveProperty('textAlign');
    expect(JSON.stringify(table)).not.toMatch(/secret|onclick|https|Infinity/);
  });

  it('retains unthemed white fallback and explicit alpha or transparency', () => {
    const table = mapTable({
      theme: undefined,
      outline: undefined,
      data: [
        [
          cell(),
          cell('a', { backcolor: 'rgba(1,2,3,0.5)' }),
          cell('b', { backcolor: 'transparent' }),
        ],
      ],
    });
    expect(table.rows[0]!.cells.map((value) => value.style.fill)).toEqual([
      fill('#FFFFFF'),
      fill('#010203', 0.5),
      fill('#000000', 0),
    ]);
    expect(table.rows[0]!.cells[0]!.style).not.toHaveProperty('stroke');
  });

  it.each([false, true])(
    'uses physical columns for merged header/footer cells (placeholders=%s)',
    (placeholders) => {
      const span = { ...cell(), colspan: 2 };
      const vertical = { ...cell(), rowspan: 2 };
      const table = mapTable({
        theme: { color: '#5b9bd5', colHeader: true, colFooter: true, rowFooter: true },
        data: [
          placeholders ? [span, cell(), cell()] : [span, cell()],
          [vertical, cell(), cell()],
          placeholders ? [cell(), cell(), cell()] : [cell(), cell()],
          [cell(), cell(), cell()],
        ],
      });
      expect(table.rows[0]!.cells).toHaveLength(2);
      expect(table.rows[0]!.cells.map((value) => value.style.fill)).toEqual([
        fill('#5B9BD5'),
        fill('#5B9BD5'),
      ]);
      expect(table.rows[2]!.cells.map((value) => value.style.fill)).toEqual([
        fill('#EFF5FB'),
        fill('#5B9BD5'),
      ]);
      expect(table.rows[3]!.cells.map((value) => value.style.fill)).toEqual([
        fill('#5B9BD5'),
        fill('#5B9BD5'),
        fill('#5B9BD5'),
      ]);
    },
  );
});
