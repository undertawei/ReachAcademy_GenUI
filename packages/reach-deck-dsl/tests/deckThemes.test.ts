import { describe, expect, it } from 'vitest';

import {
  DECK_THEME_LIBRARY,
  DECK_THEME_NAMES,
  DEFAULT_DECK_THEME_NAME,
  deckThemeCatalogSnippet,
  isDeckThemeName,
  resolveDeckTheme,
} from '../src/deckThemes.js';
import type { DeckTheme } from '../src/types.js';

/** sRGB 分量线性化（WCAG 2.x 相对亮度定义）。 */
const linearize = (channel: number): number =>
  channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** 相对亮度：#rrggbb → L。 */
const relativeLuminance = (hex: string): number => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) throw new Error(`色值不是 #rrggbb 形式：${hex}`);
  const value = match[1]!;
  const [r, g, b] = [0, 2, 4].map((offset) =>
    linearize(Number.parseInt(value.slice(offset, offset + 2), 16) / 255),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 对比比值：(L_light + 0.05) / (L_dark + 0.05)，值域 1–21。 */
const contrastRatio = (left: string, right: string): number => {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const SEMANTIC_COLOR_SLOTS = [
  'background',
  'surface',
  'ink',
  'muted',
  'accent',
  'success',
  'warning',
] as const satisfies ReadonlyArray<keyof DeckTheme>;

describe('对比度计算', () => {
  // 先自检公式：黑白极值与同色下界是 WCAG 定义的已知锚点。
  it('黑白对比为 21:1，同色为 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#2563eb', '#2563eb')).toBeCloseTo(1, 5);
  });
});

describe('主题库', () => {
  it('主题名清单与库条目一一对应且无重复', () => {
    expect(DECK_THEME_LIBRARY.map((entry) => entry.name)).toEqual([...DECK_THEME_NAMES]);
    expect(new Set(DECK_THEME_NAMES).size).toBe(DECK_THEME_NAMES.length);
  });

  it('提供 4-6 个精选主题', () => {
    expect(DECK_THEME_LIBRARY.length).toBeGreaterThanOrEqual(4);
    expect(DECK_THEME_LIBRARY.length).toBeLessThanOrEqual(6);
  });

  it('每个主题语义槽齐全、色值均为 #rrggbb、字体非空', () => {
    for (const { name, theme, description, guidance } of DECK_THEME_LIBRARY) {
      for (const slot of SEMANTIC_COLOR_SLOTS) {
        expect(theme[slot], `${name}.${slot}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(theme.name.trim().length, `${name}.name`).toBeGreaterThan(0);
      expect(theme.fontDisplay.trim().length).toBeGreaterThan(0);
      expect(theme.fontBody.trim().length).toBeGreaterThan(0);
      expect(description.trim().length, `${name} 缺中文场景说明`).toBeGreaterThan(0);
      expect(guidance.trim().length, `${name} 缺 prompt 英文说明`).toBeGreaterThan(0);
    }
  });

  it('全库字体统一，避免 textCapacityTable 容量标定失准', () => {
    const fonts = new Set(
      DECK_THEME_LIBRARY.map((entry) => `${entry.theme.fontDisplay}|${entry.theme.fontBody}`),
    );
    expect(fonts.size).toBe(1);
  });

  // 正文可读性是硬门槛：ink 落在 background 与 surface 上都要过 AA(4.5:1)。
  it('ink 对 background / surface 均满足 WCAG AA 4.5:1', () => {
    for (const { name, theme } of DECK_THEME_LIBRARY) {
      expect(contrastRatio(theme.ink, theme.background), `${name}: ink/background`).toBeGreaterThan(
        4.5,
      );
      expect(contrastRatio(theme.ink, theme.surface), `${name}: ink/surface`).toBeGreaterThan(4.5);
    }
  });

  // muted 承载副文本，仍按正文标准要求——它不是装饰色。
  it('muted 对 background / surface 满足 WCAG AA 4.5:1', () => {
    for (const { name, theme } of DECK_THEME_LIBRARY) {
      expect(
        contrastRatio(theme.muted, theme.background),
        `${name}: muted/background`,
      ).toBeGreaterThan(4.5);
      expect(contrastRatio(theme.muted, theme.surface), `${name}: muted/surface`).toBeGreaterThan(
        4.5,
      );
    }
  });

  // accent/success/warning 用于强调短语与数字，取 AA 大字号档 3:1 下限。
  it('accent / success / warning 对背景对比清晰（>= 3:1）', () => {
    for (const { name, theme } of DECK_THEME_LIBRARY) {
      for (const slot of ['accent', 'success', 'warning'] as const) {
        expect(
          contrastRatio(theme[slot], theme.background),
          `${name}: ${slot}/background`,
        ).toBeGreaterThan(3);
        expect(
          contrastRatio(theme[slot], theme.surface),
          `${name}: ${slot}/surface`,
        ).toBeGreaterThan(3);
      }
    }
  });

  it('background 与 surface 可区分但不刺目', () => {
    for (const { name, theme } of DECK_THEME_LIBRARY) {
      const ratio = contrastRatio(theme.background, theme.surface);
      expect(ratio, `${name}: background/surface 应有层次`).toBeGreaterThan(1.01);
      expect(ratio, `${name}: background/surface 反差过大`).toBeLessThan(2);
    }
  });
});

describe('主题解析', () => {
  it('默认主题保持历史色值并统一使用自托管 Source Han Sans', () => {
    expect(resolveDeckTheme(DEFAULT_DECK_THEME_NAME)).toEqual({
      name: 'Reach',
      background: '#ffffff',
      surface: '#f8fafc',
      ink: '#172024',
      muted: '#647178',
      accent: '#2563eb',
      success: '#15803d',
      warning: '#b45309',
      fontDisplay: 'Source Han Sans VF',
      fontBody: 'Source Han Sans VF',
    });
  });

  it('未知主题名与 undefined 一律回落默认主题', () => {
    const fallback = resolveDeckTheme(DEFAULT_DECK_THEME_NAME);
    expect(resolveDeckTheme(undefined)).toEqual(fallback);
    expect(resolveDeckTheme('no-such-theme')).toEqual(fallback);
    expect(resolveDeckTheme('')).toEqual(fallback);
  });

  it('库内每个主题名都解析到自身条目', () => {
    for (const { name, theme } of DECK_THEME_LIBRARY) {
      expect(resolveDeckTheme(name)).toEqual(theme);
    }
  });

  it('isDeckThemeName 只认库内名字', () => {
    for (const name of DECK_THEME_NAMES) expect(isDeckThemeName(name)).toBe(true);
    for (const value of ['Reach', 'deep tech', undefined, null, 7, {}]) {
      expect(isDeckThemeName(value)).toBe(false);
    }
  });

  it('主题名与展示名互不相同，避免落库写错字段', () => {
    for (const { name, theme } of DECK_THEME_LIBRARY) expect(name).not.toBe(theme.name);
  });
});

describe('prompt 说明段', () => {
  it('列出全部主题名且为英文正文', () => {
    const snippet = deckThemeCatalogSnippet();
    for (const name of DECK_THEME_NAMES) expect(snippet).toContain(name);
    // prompt 正文一律英文：说明段不得混入中文。
    expect(snippet).not.toMatch(/[一-鿿]/);
  });
});
