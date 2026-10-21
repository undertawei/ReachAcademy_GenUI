import {
  parseReachDeckNativeSlideV2,
  richTextFromPlainText,
  richTextToPlainText,
  summarizeNativeSlideElementsForNarration,
  type ReachDeckDesignContext,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '@reachany/reach-deck-dsl/reference-library';
import { describe, expect, it } from 'vitest';
import { compileHtmlLayout } from '../../lib/reach-deck/html-layout/index.js';

type Cell = { text: string; header?: boolean; col?: number; rowSpan?: number; columnSpan?: number };
type Fixture = {
  template: string;
  rows: Cell[][];
  columns: number;
  width: number;
  extra?: { id: string; text: string; x: number; y: number; width: number };
};
const fixtures: Fixture[] = [
  {
    template: 'full-width-comparison',
    columns: 3,
    width: 1400,
    rows: [
      [
        { text: 'State', header: true },
        { text: 'Net force', header: true },
        { text: 'Observation', header: true },
      ],
      [{ text: 'At rest', header: true }, { text: 'Zero' }, { text: 'Remains at rest' }],
      [
        { text: 'Uniform motion', header: true },
        { text: 'Zero' },
        { text: 'Velocity stays unchanged' },
      ],
      [
        { text: 'Changing motion', header: true },
        { text: 'Nonzero' },
        { text: 'Speed or direction changes' },
      ],
    ],
  },
  {
    template: 'table-with-question-rail',
    columns: 2,
    width: 900,
    rows: [
      [
        { text: 'Map component', header: true },
        { text: 'Reading action', header: true },
      ],
      [{ text: 'Title', header: true }, { text: 'Read the subject first' }],
      [{ text: 'Legend', header: true }, { text: 'Match symbols to meanings' }],
      [{ text: 'Scale', header: true }, { text: 'Compare map and ground distance' }],
    ],
    extra: {
      id: 'question-rail',
      text: 'Which component explains a symbol?',
      x: 1100,
      y: 200,
      width: 380,
    },
  },
  {
    template: 'table-with-insight-band',
    columns: 3,
    width: 1400,
    rows: [
      [{ text: 'Observed trial results', header: true, columnSpan: 3 }],
      [
        { text: 'Trial', header: true },
        { text: 'Before', header: true },
        { text: 'After', header: true },
      ],
      [{ text: 'A', header: true }, { text: '12' }, { text: '18' }],
      [{ text: 'B', header: true }, { text: '15' }, { text: '21' }],
    ],
    extra: {
      id: 'insight-band',
      text: 'Both observed trials increase by six.',
      x: 100,
      y: 650,
      width: 1400,
    },
  },
  {
    template: 'row-header-progression-matrix',
    columns: 4,
    width: 1400,
    rows: [
      [
        { text: 'Dimension', header: true, rowSpan: 2 },
        { text: 'Foundation', header: true, columnSpan: 2 },
        { text: 'Transfer', header: true, col: 3, rowSpan: 2 },
      ],
      [
        { text: 'Observe', header: true, col: 1 },
        { text: 'Explain', header: true, col: 2 },
      ],
      [
        { text: 'Evidence', header: true },
        { text: 'Name features' },
        { text: 'Compare observations' },
        { text: 'Justify a prediction' },
      ],
      [
        { text: 'Reasoning', header: true },
        { text: 'Record findings' },
        { text: 'Connect claims' },
        { text: 'Apply the relationship' },
      ],
    ],
  },
];

const designContext: ReachDeckDesignContext = {
  schemaVersion: 'reach-deck-design-context/v1',
  libraryVersion: REFERENCE_LIBRARY_VERSION,
  librarySha256: REFERENCE_LIBRARY_SHA256,
  paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
  imageStyleReferenceIds: [],
  visualIntent: 'Readable editable evidence table',
  resolvedColors: {
    background: '#ffffff',
    surface: '#eeeeee',
    ink: '#111111',
    muted: '#444444',
    accent: '#005599',
    success: '#006633',
    warning: '#885500',
  },
};

describe('distinct reference table templates in Chromium', () => {
  it('covers every declared tableTemplate with a distinct structure', () => {
    const declared = REFERENCE_LIBRARY.layouts.flatMap((layout) =>
      'tableTemplate' in layout ? [layout.tableTemplate] : [],
    );
    expect(new Set(fixtures.map((fixture) => fixture.template))).toEqual(new Set(declared));
    expect(new Set(fixtures.map((fixture) => JSON.stringify(fixture.rows))).size).toBe(4);
  });

  it.each(fixtures)(
    '$template remains editable with complete narration',
    async (fixture) => {
      const cellsHtml = fixture.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell) => {
                const tag = cell.header ? 'th' : 'td';
                return `<${tag} rowspan="${cell.rowSpan ?? 1}" colspan="${cell.columnSpan ?? 1}" style="padding:14px;border:1px solid #555;background:${cell.header ? '#eeeeee' : '#ffffff'};text-align:left">${cell.text}</${tag}>`;
              })
              .join('')}</tr>`,
        )
        .join('');
      const extra = fixture.extra;
      const result = await compileHtmlLayout({
        html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:#fff;color:#111"><h1 id="title" style="position:absolute;left:100px;top:50px;width:1400px;height:70px;margin:0;font:40px 'Source Han Sans VF'">Teaching evidence</h1><table id="evidence-table" style="position:absolute;left:100px;top:180px;width:${fixture.width}px;table-layout:fixed;border-collapse:collapse;font:26px/36px 'Source Han Sans VF'">${cellsHtml}</table>${extra ? `<p id="${extra.id}" style="position:absolute;left:${extra.x}px;top:${extra.y}px;width:${extra.width}px;height:140px;margin:0;font:30px/42px 'Source Han Sans VF'">${extra.text}</p>` : ''}</section></body></html>`,
        pageId: fixture.template,
        themeName: 'reach-classic',
        designContext,
        assets: [],
      });
      const slide = parseReachDeckNativeSlideV2(JSON.parse(JSON.stringify(result.slide)));
      const table = slide.elements.find((element) => element.id === 'evidence-table');
      if (table?.type !== 'table') throw new Error('Expected editable Native table');
      expect(
        slide.elements.every((element) => element.type === 'table' || element.type === 'textFrame'),
      ).toBe(true);
      expect(result.pendingMedia).toEqual([]);
      expect(result.resources).toEqual([]);
      expect(table.rows).toHaveLength(fixture.rows.length);
      expect(table.columnWidths).toHaveLength(fixture.columns);

      const projection = summarizeNativeSlideElementsForNarration(slide);
      const narration = projection.find((element) => element.id === table.id);
      expect(narration?.type).toBe('table');
      expect(narration!.text.split('\n')).toHaveLength(fixture.rows.length);
      let coveredPositions = 0;
      fixture.rows.forEach((row, rowIndex) => {
        expect(table.rows[rowIndex]!.cells).toHaveLength(row.length);
        let column = 0;
        row.forEach((cell, index) => {
          column = cell.col ?? column;
          const native = table.rows[rowIndex]!.cells[index]!;
          expect(native.header ?? false).toBe(cell.header ?? false);
          expect(native.rowSpan).toBe(cell.rowSpan ?? 1);
          expect(native.columnSpan).toBe(cell.columnSpan ?? 1);
          expect(richTextToPlainText(native.text.doc)).toBe(cell.text);
          const origin = `row ${rowIndex + 1}, column ${column + 1}`;
          const descriptor = `${cell.header ? 'header' : 'cell'} (${origin}; rowSpan ${cell.rowSpan ?? 1}, columnSpan ${cell.columnSpan ?? 1}): ${JSON.stringify(cell.text)}`;
          expect(narration!.text.split(descriptor)).toHaveLength(2);
          const covered = (cell.rowSpan ?? 1) * (cell.columnSpan ?? 1) - 1;
          expect(narration!.text.split(`[covered by ${origin}]`)).toHaveLength(covered + 1);
          coveredPositions += covered;
          column += cell.columnSpan ?? 1;
        });
      });
      expect((narration!.text.match(/\[covered by /g) ?? []).length).toBe(coveredPositions);
      expect(narration!.text).not.toContain('[blank]');

      if (extra) {
        const nativeExtra = slide.elements.find((element) => element.id === extra.id)!;
        expect(nativeExtra.type).toBe('textFrame');
        expect(projection.find((element) => element.id === extra.id)?.text).toBe(extra.text);
        if (extra.id === 'question-rail') {
          expect(nativeExtra.transform.x).toBeGreaterThan(
            table.transform.x + table.transform.width,
          );
        } else {
          expect(nativeExtra.transform.y).toBeGreaterThan(
            table.transform.y + table.transform.height,
          );
        }
      }

      table.rows.at(-1)!.cells.at(-1)!.text.doc = richTextFromPlainText(
        'Edited cell survives JSON save',
      );
      const restored = parseReachDeckNativeSlideV2(JSON.parse(JSON.stringify(slide)));
      expect(
        summarizeNativeSlideElementsForNarration(restored).find(
          (element) => element.id === table.id,
        )?.text,
      ).toContain('Edited cell survives JSON save');
    },
    60_000,
  );
});
