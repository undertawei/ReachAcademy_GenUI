import { describe, expect, it } from 'vitest';

import { TYPOGRAPHY_TOKENS } from '../src/layoutContract.js';
import {
  CALIBRATED_WIDTHS_PX,
  DERIVED_NARROW_WIDTHS_PX,
  NARROW_WIDTH_SAFETY_RATIO,
  TEXT_CAPACITY_TABLE,
  TEXT_CAPACITY_WIDTHS_PX,
} from '../src/textCapacityTable.js';

const TOKEN_NAMES = Object.keys(TYPOGRAPHY_TOKENS) as (keyof typeof TYPOGRAPHY_TOKENS)[];

describe('TEXT_CAPACITY_TABLE', () => {
  it('覆盖每个排版档位 × 每个标定槽宽', () => {
    for (const tokenName of TOKEN_NAMES) {
      const row = TEXT_CAPACITY_TABLE[tokenName];
      expect(row).toBeDefined();
      for (const width of CALIBRATED_WIDTHS_PX) {
        expect(row[width]).toBeDefined();
      }
    }
  });

  it('单独标识保守推导的窄框档，并把完整断点按宽度递增排列', () => {
    expect(DERIVED_NARROW_WIDTHS_PX).toEqual([160, 192, 240, 280]);
    expect(TEXT_CAPACITY_WIDTHS_PX).toEqual([...DERIVED_NARROW_WIDTHS_PX, ...CALIBRATED_WIDTHS_PX]);
    expect([...TEXT_CAPACITY_WIDTHS_PX].sort((left, right) => left - right)).toEqual(
      TEXT_CAPACITY_WIDTHS_PX,
    );
  });

  it('窄框容量由 480px 稳定档按宽度与安全系数保守推导', () => {
    for (const tokenName of TOKEN_NAMES) {
      const reference = TEXT_CAPACITY_TABLE[tokenName][480];
      const maxLines = TYPOGRAPHY_TOKENS[tokenName].maxLines;
      for (const width of DERIVED_NARROW_WIDTHS_PX) {
        const cell = TEXT_CAPACITY_TABLE[tokenName][width];
        expect(cell.cjkCharsPerLine).toBe(
          Math.max(
            1,
            Math.floor(reference.cjkCharsPerLine * (width / 480) * NARROW_WIDTH_SAFETY_RATIO),
          ),
        );
        expect(cell.latinCharsPerLine).toBe(
          Math.max(
            1,
            Math.floor(reference.latinCharsPerLine * (width / 480) * NARROW_WIDTH_SAFETY_RATIO),
          ),
        );
        expect(cell.maxCjkChars).toBe(cell.cjkCharsPerLine * maxLines);
        expect(cell.maxLatinChars).toBe(cell.latinCharsPerLine * maxLines);
      }
    }
  });

  it('每个单元格都是正整数', () => {
    for (const tokenName of TOKEN_NAMES) {
      for (const width of TEXT_CAPACITY_WIDTHS_PX) {
        const cell = TEXT_CAPACITY_TABLE[tokenName][width];
        for (const value of Object.values(cell)) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThan(0);
        }
      }
    }
  });

  it('同一档位下，槽宽越大，每行字数与总容量单调不减', () => {
    for (const tokenName of TOKEN_NAMES) {
      const row = TEXT_CAPACITY_TABLE[tokenName];
      for (let i = 1; i < TEXT_CAPACITY_WIDTHS_PX.length; i += 1) {
        const previous = row[TEXT_CAPACITY_WIDTHS_PX[i - 1]];
        const current = row[TEXT_CAPACITY_WIDTHS_PX[i]];
        expect(current.cjkCharsPerLine).toBeGreaterThanOrEqual(previous.cjkCharsPerLine);
        expect(current.latinCharsPerLine).toBeGreaterThanOrEqual(previous.latinCharsPerLine);
        expect(current.maxCjkChars).toBeGreaterThanOrEqual(previous.maxCjkChars);
        expect(current.maxLatinChars).toBeGreaterThanOrEqual(previous.maxLatinChars);
      }
    }
  });

  it('同一档位同一槽宽下，英文每行字符数不小于中文每行字数（西文字符更窄）', () => {
    for (const tokenName of TOKEN_NAMES) {
      for (const width of TEXT_CAPACITY_WIDTHS_PX) {
        const cell = TEXT_CAPACITY_TABLE[tokenName][width];
        expect(cell.latinCharsPerLine).toBeGreaterThanOrEqual(cell.cjkCharsPerLine);
      }
    }
  });

  it('maxCjkChars / maxLatinChars 等于每行字数乘以该档位 maxLines', () => {
    for (const tokenName of TOKEN_NAMES) {
      const maxLines = TYPOGRAPHY_TOKENS[tokenName].maxLines;
      for (const width of TEXT_CAPACITY_WIDTHS_PX) {
        const cell = TEXT_CAPACITY_TABLE[tokenName][width];
        expect(cell.maxCjkChars).toBe(cell.cjkCharsPerLine * maxLines);
        expect(cell.maxLatinChars).toBe(cell.latinCharsPerLine * maxLines);
      }
    }
  });

  it('字号越大的档位，同一槽宽下每行字数越少（title 比 body 字号大，容量应更小）', () => {
    for (const width of TEXT_CAPACITY_WIDTHS_PX) {
      expect(TEXT_CAPACITY_TABLE.title[width].cjkCharsPerLine).toBeLessThan(
        TEXT_CAPACITY_TABLE.body[width].cjkCharsPerLine,
      );
    }
  });
});
