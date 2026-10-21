import { describe, expect, it } from 'vitest';

import {
  definePptxFontCatalog,
  resolvePptxFont,
  type PptxThemeFontScheme,
} from '../src/pptx/index.js';

const catalog = definePptxFontCatalog({
  version: 'reach-fonts/1',
  families: [
    { family: 'Reach Sans', aliases: ['ReachSans'], scripts: ['latin'] },
    { family: 'Reach CJK', aliases: [], scripts: ['eastAsia'] },
    { family: 'Reach Arabic', aliases: [], scripts: ['complexScript'] },
  ],
  substitutions: [
    { requestedFamily: 'Calibri', candidates: ['Reach Sans'] },
    { requestedFamily: 'DengXian', candidates: ['Reach CJK'] },
  ],
  fallbacksByScript: {
    latin: ['Reach Sans'],
    eastAsia: ['Reach CJK'],
    complexScript: ['Reach Arabic'],
    symbol: [],
  },
});

const theme: PptxThemeFontScheme = {
  major: {
    latin: 'Calibri',
    eastAsia: 'DengXian',
    complexScript: 'Reach Arabic',
    symbol: 'Wingdings',
  },
  minor: {
    latin: 'Reach Sans',
    eastAsia: 'Reach CJK',
    complexScript: 'Reach Arabic',
    symbol: 'Wingdings',
  },
};

describe('deterministic PPTX font substitution', () => {
  it('resolves direct aliases without substitution', () => {
    const result = resolvePptxFont(
      { source: { kind: 'direct', family: ' reachsans ' }, script: 'latin' },
      catalog,
      theme,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.font).toMatchObject({
      requestedFamily: 'reachsans',
      resolvedFamily: 'Reach Sans',
      reason: 'requested-available',
      catalogVersion: 'reach-fonts/1',
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('preserves theme provenance and records the selected substitution', () => {
    const result = resolvePptxFont(
      { source: { kind: 'theme', set: 'major' }, script: 'eastAsia' },
      catalog,
      theme,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.font).toMatchObject({
      source: { kind: 'theme', set: 'major' },
      requestedFamily: 'DengXian',
      resolvedFamily: 'Reach CJK',
      reason: 'catalog-substitution',
    });
    expect(result.diagnostics[0]).toMatchObject({
      code: 'pptx.font.substituted',
      severity: 'warning',
    });
  });

  it('blocks when neither substitution nor script fallback is available', () => {
    const result = resolvePptxFont(
      { source: { kind: 'direct', family: 'Wingdings' }, script: 'symbol' },
      catalog,
      theme,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: 'pptx.font.unresolved',
      severity: 'error',
      feature: 'font-substitution',
    });
  });
});
