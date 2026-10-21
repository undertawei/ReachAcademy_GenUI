import { describe, expect, it } from 'vitest';

import {
  definePptxFontCatalog,
  fitPptxTextFrame,
  hasBlockingPptxDiagnostics,
  type PptxFontMetricsProvider,
  type PptxTextFrameFitRequest,
  type PptxThemeFontScheme,
} from '../src/pptx/index.js';

const catalog = definePptxFontCatalog({
  version: 'test-fonts/1',
  families: [
    { family: 'Test Sans', aliases: [], scripts: ['latin'] },
    { family: 'Test CJK', aliases: [], scripts: ['eastAsia'] },
  ],
  substitutions: [{ requestedFamily: 'Calibri', candidates: ['Test Sans'] }],
  fallbacksByScript: {
    latin: ['Test Sans'],
    eastAsia: ['Test CJK'],
    complexScript: [],
    symbol: [],
  },
});

const theme: PptxThemeFontScheme = {
  major: {
    latin: 'Calibri',
    eastAsia: 'Test CJK',
    complexScript: 'Missing Complex',
    symbol: 'Missing Symbol',
  },
  minor: {
    latin: 'Test Sans',
    eastAsia: 'Test CJK',
    complexScript: 'Missing Complex',
    symbol: 'Missing Symbol',
  },
};

const metrics: PptxFontMetricsProvider = {
  version: 'linear-metrics/1',
  measureText: ({ family, text, fontSizePt, letterSpacingPt }) => {
    if (family !== 'Test Sans' && family !== 'Test CJK') return undefined;
    const characters = Array.from(text).length;
    return {
      advanceWidthPt: characters * fontSizePt * 0.5 + Math.max(0, characters - 1) * letterSpacingPt,
      ascentPt: fontSizePt * 0.7,
      descentPt: fontSizePt * 0.2,
      lineGapPt: fontSizePt * 0.1,
    };
  },
};

const request = (overrides: Partial<PptxTextFrameFitRequest> = {}): PptxTextFrameFitRequest => ({
  widthPt: 80,
  heightPt: 40,
  insetLeftPt: 0,
  insetRightPt: 0,
  insetTopPt: 0,
  insetBottomPt: 0,
  wrap: true,
  tolerancePt: 0.000_001,
  autoFit: {
    mode: 'shrink',
    minimumFontScale: 0.5,
    fontScaleStep: 0.1,
    maximumLineSpacingReduction: 0.2,
    lineSpacingReductionStep: 0.1,
  },
  paragraphs: [
    {
      id: 'p1',
      lineSpacingMultiplier: 1,
      spaceBeforePt: 0,
      spaceAfterPt: 0,
      list: { level: 2, markerText: '1.', indentationPt: 24, markerGapPt: 2 },
      runs: [
        {
          id: 'r1',
          text: 'one two three four',
          font: { source: { kind: 'theme', set: 'major' }, script: 'latin' },
          fontSizePt: 20,
          fontWeight: 400,
          italic: false,
          letterSpacingPt: 0,
        },
      ],
    },
  ],
  ...overrides,
});

describe('post-substitution PPTX text fitting', () => {
  it('measures multiple paragraphs and script-specific runs with injected metrics only', () => {
    const result = fitPptxTextFrame(
      request({
        widthPt: 100,
        heightPt: 30,
        autoFit: { mode: 'none' },
        paragraphs: [
          {
            id: 'latin-paragraph',
            lineSpacingMultiplier: 1,
            spaceBeforePt: 0,
            spaceAfterPt: 0,
            runs: [
              {
                id: 'latin-run',
                text: 'ab',
                font: { source: { kind: 'theme', set: 'minor' }, script: 'latin' },
                fontSizePt: 10,
                fontWeight: 400,
                italic: false,
                letterSpacingPt: 0,
              },
            ],
          },
          {
            id: 'cjk-paragraph',
            lineSpacingMultiplier: 1,
            spaceBeforePt: 0,
            spaceAfterPt: 0,
            runs: [
              {
                id: 'cjk-run',
                text: '你好',
                font: { source: { kind: 'theme', set: 'minor' }, script: 'eastAsia' },
                fontSizePt: 10,
                fontWeight: 400,
                italic: false,
                letterSpacingPt: 0,
              },
            ],
          },
        ],
      }),
      catalog,
      theme,
      metrics,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runs.map((run) => run.resolvedFont.resolvedFamily)).toEqual([
      'Test Sans',
      'Test CJK',
    ]);
    expect(result.measurement).toMatchObject({ widthPt: 10, heightPt: 20 });
    expect(result.measurement.paragraphs).toHaveLength(2);
  });

  it('measures list text and chooses a deterministic permitted autofit step', () => {
    const result = fitPptxTextFrame(request(), catalog, theme, metrics);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalogVersion).toBe('test-fonts/1');
    expect(result.metricsVersion).toBe('linear-metrics/1');
    expect(result.fontScale).toBe(0.8);
    expect(result.lineSpacingReduction).toBe(0.2);
    expect(result.runs[0]).toMatchObject({
      id: 'r1',
      fittedFontSizePt: 16,
      resolvedFont: {
        requestedFamily: 'Calibri',
        resolvedFamily: 'Test Sans',
        reason: 'catalog-substitution',
      },
    });
    expect(result.measurement.paragraphs[0]).toMatchObject({ listLevel: 2, lineCount: 3 });
    expect(hasBlockingPptxDiagnostics(result.diagnostics)).toBe(false);
  });

  it('returns a blocking diagnostic when exact metrics are unavailable', () => {
    const result = fitPptxTextFrame(request(), catalog, theme, {
      version: 'missing/1',
      measureText: () => undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'pptx.font.metrics_missing', severity: 'error' }),
    );
  });

  it('blocks instead of silently overflowing when minimum autofit cannot fit', () => {
    const result = fitPptxTextFrame(
      request({
        widthPt: 10,
        heightPt: 10,
        autoFit: {
          mode: 'shrink',
          minimumFontScale: 0.9,
          fontScaleStep: 0.1,
          maximumLineSpacingReduction: 0,
          lineSpacingReductionStep: 0.1,
        },
      }),
      catalog,
      theme,
      metrics,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.text.overflow_after_substitution',
        severity: 'error',
        feature: 'text-frame',
      }),
    );
  });
});
