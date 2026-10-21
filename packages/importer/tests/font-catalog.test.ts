import { describe, expect, it } from 'vitest';
import { REACH_DECK_BUILT_IN_FONT_FAMILIES } from '@reachany/reach-deck-dsl';

import {
  REACH_PPTX_FONT_CATALOG,
  resolvePptxFont,
  type PptxThemeFontScheme,
} from '../src/pptx/index.js';

const theme: PptxThemeFontScheme = {
  major: { latin: 'Times New Roman', eastAsia: '宋体', complexScript: 'Arial', symbol: 'Symbol' },
  minor: { latin: 'Calibri', eastAsia: '等线', complexScript: 'Arial', symbol: 'Symbol' },
};

const resolve = (family: string, script: 'latin' | 'eastAsia' | 'complexScript' | 'symbol') =>
  resolvePptxFont({ source: { kind: 'direct', family }, script }, REACH_PPTX_FONT_CATALOG, theme);

describe('built-in Reach PPTX font catalog', () => {
  it('matches the font families exposed by the Reach Deck slide toolbar', () => {
    expect(REACH_PPTX_FONT_CATALOG.families.map(({ family }) => family)).toEqual(
      REACH_DECK_BUILT_IN_FONT_FAMILIES,
    );
  });

  it('resolves bundled families and their Chinese aliases directly', () => {
    for (const [name, expected] of [
      ['SourceHanSans', 'Source Han Sans VF'],
      ['思源黑体', 'Source Han Sans VF'],
      ['思源宋体', 'Source Han Serif SC'],
      ['霞鹜文楷', 'LXGW WenKai'],
      ['阿里巴巴普惠体 3.0', 'Alibaba PuHuiTi 3.0'],
    ] as const) {
      const result = resolve(name, 'eastAsia');
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.font.resolvedFamily).toBe(expected);
      expect(result.font.reason).toBe('requested-available');
    }
  });

  it('substitutes the system fonts observed in teaching decks', () => {
    for (const [requested, script, expected] of [
      ['宋体', 'eastAsia', 'Source Han Serif SC'],
      ['黑体', 'eastAsia', 'Source Han Sans VF'],
      ['微软雅黑', 'eastAsia', 'Source Han Sans VF'],
      ['等线', 'eastAsia', 'Alibaba PuHuiTi 3.0'],
      ['楷体', 'eastAsia', 'LXGW WenKai'],
      ['仿宋', 'eastAsia', 'Zhuque Fangsong (technical preview)'],
      ['华文中宋', 'eastAsia', 'Source Han Serif SC'],
      ['Times New Roman', 'latin', 'Liberation Serif'],
      ['Arial', 'latin', 'Liberation Sans'],
      ['Calibri', 'latin', 'Carlito'],
      ['Cambria Math', 'latin', 'STIX Two Math'],
      ['ISOCPEUR', 'latin', 'osifont'],
    ] as const) {
      const result = resolve(requested, script);
      expect(result.ok, `${requested} should resolve`).toBe(true);
      if (!result.ok) continue;
      expect(result.font.resolvedFamily, requested).toBe(expected);
      expect(result.font.reason).toBe('catalog-substitution');
      expect(result.diagnostics[0]).toMatchObject({ code: 'pptx.font.substituted' });
    }
  });

  it('falls back per script for unknown families', () => {
    const cjk = resolve('某未知教学字体', 'eastAsia');
    expect(cjk.ok).toBe(true);
    if (cjk.ok) {
      expect(cjk.font.resolvedFamily).toBe('Source Han Sans VF');
      expect(cjk.font.reason).toBe('script-fallback');
    }

    const latin = resolve('Unknown Display', 'latin');
    expect(latin.ok).toBe(true);
    if (latin.ok) {
      expect(latin.font.resolvedFamily).toBe('Carlito');
      expect(latin.font.reason).toBe('script-fallback');
    }
  });

  it('refuses to invent symbol or complex-script coverage', () => {
    for (const [family, script] of [
      ['Wingdings', 'symbol'],
      ['Mangal', 'complexScript'],
    ] as const) {
      const result = resolve(family, script);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics[0]).toMatchObject({ code: 'pptx.font.unresolved' });
    }
  });
});
