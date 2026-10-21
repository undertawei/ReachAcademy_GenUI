import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { preflightReachDeckMaic } from '../../lib/reach-deck/maic-import.js';
import * as fonts from '../../lib/reach-deck/maic-table-fonts.js';

const source = (text: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      title: 'Table layout',
      width: 1000,
      height: 562.5,
      slides: [
        {
          id: 'slide',
          component_type: 'canvas',
          elements: [
            {
              id: 'table',
              type: 'table',
              left: 20,
              top: 30,
              width: 400,
              height: 120,
              colWidths: [0.5, 0.5],
              cellMinHeight: 30,
              outline: { width: 1, style: 'solid', color: '#000000' },
              data: [
                [
                  { text: 'Short', style: { fontsize: '20px' } },
                  { text: 'Short', style: { fontsize: '20px' } },
                ],
                [
                  { text, style: { fontsize: '20px' } },
                  { text: 'Short', style: { fontsize: '20px' } },
                ],
              ],
            },
          ],
        },
      ],
    }),
  );
const options = {
  applicationId: 'table-layout',
  documentId: 'table-layout',
  title: 'Table layout',
  language: 'en-US',
  generatedAt: '2026-09-20T00:00:00Z',
};

afterEach(() => vi.restoreAllMocks());

describe('MAIC table font measurements', () => {
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const fontDirectory = path.join(repositoryRoot, 'packages/reach-deck-player/fonts/sources');

  it('resolves font assets from repository and service working directories', async () => {
    for (const cwd of [repositoryRoot, path.join(repositoryRoot, 'services/ai-runtime')]) {
      await expect(fonts.resolveMaicTableFontDirectory('', cwd)).resolves.toBe(fontDirectory);
    }
  });

  it('uses an explicit font directory independently of the working directory', async () => {
    await expect(
      fonts.resolveMaicTableFontDirectory(fontDirectory, path.join(repositoryRoot, 'tmp')),
    ).resolves.toBe(fontDirectory);
  });

  it('rejects an incomplete explicit directory without falling back to bundled assets', async () => {
    await expect(
      fonts.resolveMaicTableFontDirectory(repositoryRoot, repositoryRoot),
    ).rejects.toThrow('Required MAIC table fonts are unavailable.');
  });

  it('rejects working directories without bundled font assets', async () => {
    await expect(
      fonts.resolveMaicTableFontDirectory('', path.join(repositoryRoot, 'tmp/no-fonts/nested')),
    ).rejects.toThrow('Required MAIC table fonts are unavailable.');
  });

  it('loads all actual bundled font sources and measures glyph advances and spaces', async () => {
    const metrics = await fonts.loadMaicTableFontMetrics();
    for (const family of ['Source Han Sans VF', 'Source Han Serif SC', 'LXGW WenKai']) {
      const request = {
        family,
        text: '文本',
        fontSizePt: 20,
        fontWeight: 700,
        italic: false,
        letterSpacingPt: 0,
      };
      const text = metrics.measureText(request)!;
      expect(text.advanceWidthPt).toBeCloseTo(40, 0);
      expect(text.ascentPt + text.descentPt + text.lineGapPt).toBe(20);
      expect(metrics.measureText({ ...request, text: '   ' })!.advanceWidthPt).toBeGreaterThan(0);
      expect(metrics.measureText({ ...request, fontSizePt: 40 })!.advanceWidthPt).toBeCloseTo(
        text.advanceWidthPt * 2,
      );
      expect(metrics.measureText({ ...request, text: '\u{10FFFF}' })).toBeUndefined();
    }
  });

  it('production preflight preserves short rows and grows a wrapped row before hashing', async () => {
    const short = await preflightReachDeckMaic(source('Short'), options);
    const longSource = source('Long text '.repeat(20));
    const long = await preflightReachDeckMaic(longSource, options);
    const repeat = await preflightReachDeckMaic(longSource, options);
    if (!short.ok || !long.ok || !repeat.ok) throw Error('Expected preflight success');
    const before = short.mapping!.document.nativeSlides[0]!.slide.elements[0]!;
    const after = long.mapping!.document.nativeSlides[0]!.slide.elements[0]!;
    if (before.type !== 'table' || after.type !== 'table') throw Error('Expected tables');
    expect(before.transform.height).toBe(192);
    expect(after.rowHeights[0]).toBe(before.rowHeights[0]);
    expect(after.rowHeights[1]).toBeGreaterThan(before.rowHeights[1]!);
    expect(after.transform.height).toBeCloseTo(
      after.rowHeights.reduce((sum, height) => sum + height, 0),
    );
    expect(after.transform.width).toBe(before.transform.width);
    expect(after.rows[1]!.cells[0]!.text.doc.content![0]!.content![0]!.marks).toContainEqual({
      type: 'textStyle',
      attrs: expect.objectContaining({ fontSize: '32px' }),
    });
    expect(repeat.mapping!.candidateDigest).toBe(long.mapping!.candidateDigest);
  });

  it('uses variable font weight when a bold Latin phrase crosses a wrapping boundary', async () => {
    const metrics = await fonts.loadMaicTableFontMetrics();
    const request = {
      family: 'Source Han Sans VF',
      text: 'Hello world',
      fontSizePt: 20,
      fontWeight: 400,
      italic: false,
      letterSpacingPt: 0,
    };
    // Independent Chrome measurements at these weights are 107.512 and 113.924 pixels.
    expect(metrics.measureText(request)!.advanceWidthPt).toBeCloseTo(107.512, 1);
    expect(metrics.measureText({ ...request, fontWeight: 700 })!.advanceWidthPt).toBeCloseTo(
      113.924,
      1,
    );
    const candidate = (bold: boolean) => {
      const json = JSON.parse(new TextDecoder().decode(source('Hello world')));
      const table = json.slides[0].elements[0];
      table.width = 161.5;
      table.height = 65;
      for (const row of table.data)
        for (const cell of row) cell.style = { fontsize: '12.5px', bold };
      return new TextEncoder().encode(JSON.stringify(json));
    };
    const normal = await preflightReachDeckMaic(candidate(false), options);
    const bold = await preflightReachDeckMaic(candidate(true), options);
    if (!normal.ok || !bold.ok) throw Error('Expected preflight success');
    const normalTable = normal.mapping!.document.nativeSlides[0]!.slide.elements[0]!;
    const boldTable = bold.mapping!.document.nativeSlides[0]!.slide.elements[0]!;
    if (normalTable.type !== 'table' || boldTable.type !== 'table') throw Error('Expected tables');
    expect(normalTable.rowHeights[1]).toBe(52);
    expect(boldTable.rowHeights[1]).toBeGreaterThanOrEqual(79.2);
  });

  it('does not silently accept overflowing tables when bundled fonts cannot load', async () => {
    vi.spyOn(fonts, 'loadMaicTableFontMetrics').mockRejectedValueOnce(
      new Error('Unavailable font'),
    );
    const result = await preflightReachDeckMaic(source('Long text '.repeat(20)), options);
    expect(result).toMatchObject({ ok: false, canApply: false });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'maic.table.font_metrics_unavailable' }),
    );
  });
});
