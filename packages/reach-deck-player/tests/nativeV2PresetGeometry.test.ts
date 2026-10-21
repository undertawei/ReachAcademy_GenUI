import { describe, expect, it } from 'vitest';

import {
  CSS_RENDERED_PRESET_GEOMETRIES,
  NATIVE_V2_SUPPORTED_PRESET_GEOMETRIES,
  isSvgPathPresetGeometry,
  presetGeometrySvgPath,
  roundRectCornerRadius,
} from '../src/nativeV2PresetGeometry.js';

describe('roundRectCornerRadius', () => {
  it('defaults to the OOXML 16.667% of the short side', () => {
    // min(200, 100) × 16667 / 100000 = 16.667
    expect(roundRectCornerRadius(200, 100)).toBeCloseTo(16.667, 3);
  });

  it('honours an explicit adj value and caps it at half the short side', () => {
    expect(roundRectCornerRadius(200, 100, { adj: 25_000 })).toBeCloseTo(25, 5);
    expect(roundRectCornerRadius(200, 100, { adj: 90_000 })).toBeCloseTo(50, 5);
    expect(roundRectCornerRadius(200, 100, { adj: -5_000 })).toBe(0);
  });
});

describe('presetGeometrySvgPath', () => {
  it('builds the rightArrow outline from the default adj metrics', () => {
    // 200×100 box: head length = 50, half shaft = 25.
    expect(presetGeometrySvgPath('rightArrow', 200, 100)).toEqual({
      path: 'M 0 25 L 150 25 L 150 0 L 200 50 L 150 100 L 150 75 L 0 75 Z',
      fillMode: 'norm',
    });
  });

  it('mirrors the four block arrows around the box axes', () => {
    const left = presetGeometrySvgPath('leftArrow', 200, 100);
    expect(left?.path).toBe('M 200 25 L 50 25 L 50 0 L 0 50 L 50 100 L 50 75 L 200 75 Z');
    const up = presetGeometrySvgPath('upArrow', 100, 200);
    expect(up?.path).toBe('M 25 200 L 25 50 L 0 50 L 50 0 L 100 50 L 75 50 L 75 200 Z');
    const down = presetGeometrySvgPath('downArrow', 100, 200);
    expect(down?.path).toBe('M 25 0 L 25 150 L 0 150 L 50 200 L 100 150 L 75 150 L 75 0 Z');
  });

  it('applies arrow adjustments for shaft thickness and head length', () => {
    // adj1=100000 → shaft fills the cross axis; adj2=100000 → head = short side.
    expect(presetGeometrySvgPath('rightArrow', 200, 100, { adj1: 100_000, adj2: 100_000 })).toEqual(
      {
        path: 'M 0 0 L 100 0 L 100 0 L 200 50 L 100 100 L 100 100 L 0 100 Z',
        fillMode: 'norm',
      },
    );
  });

  it('builds triangle, diamond, parallelogram and trapezoid outlines', () => {
    expect(presetGeometrySvgPath('triangle', 100, 80)?.path).toBe('M 0 80 L 50 0 L 100 80 Z');
    expect(presetGeometrySvgPath('triangle', 100, 80, { adj: 0 })?.path).toBe(
      'M 0 80 L 0 0 L 100 80 Z',
    );
    expect(presetGeometrySvgPath('diamond', 100, 80)?.path).toBe(
      'M 50 0 L 100 40 L 50 80 L 0 40 Z',
    );
    // 200×100: skew = min(w,h) × 25000/100000 = 25.
    expect(presetGeometrySvgPath('parallelogram', 200, 100)?.path).toBe(
      'M 0 100 L 25 0 L 200 0 L 175 100 Z',
    );
    expect(presetGeometrySvgPath('trapezoid', 200, 100)?.path).toBe(
      'M 0 100 L 25 0 L 175 0 L 200 100 Z',
    );
  });

  it('builds braces and bracket pairs as open unfilled stroke paths', () => {
    const leftBrace = presetGeometrySvgPath('leftBrace', 40, 200);
    expect(leftBrace?.fillMode).toBe('none');
    // Open path: starts at the top-right corner, ends bottom-right, no Z.
    expect(leftBrace?.path.startsWith('M 40 0 ')).toBe(true);
    expect(leftBrace?.path.endsWith('Q 20 200 40 200')).toBe(true);
    expect(leftBrace?.path).not.toContain('Z');
    // Tip reaches the left edge at the vertical midpoint.
    expect(leftBrace?.path).toContain('0 100');

    const rightBrace = presetGeometrySvgPath('rightBrace', 40, 200);
    expect(rightBrace?.fillMode).toBe('none');
    expect(rightBrace?.path).toContain('40 100');

    const brackets = presetGeometrySvgPath('bracketPair', 100, 200);
    expect(brackets?.fillMode).toBe('none');
    // Two disjoint subpaths, one per bracket.
    expect(brackets?.path.split('M ')).toHaveLength(3);
  });

  it('builds chevron, right triangle, star5 and two-diagonal round rect outlines', () => {
    // 200×100: tip = min(w,h) × 50000/100000 = 50。
    expect(presetGeometrySvgPath('chevron', 200, 100)?.path).toBe(
      'M 0 0 L 150 0 L 200 50 L 150 100 L 0 100 L 50 50 Z',
    );
    expect(presetGeometrySvgPath('rtTriangle', 100, 80)?.path).toBe('M 0 80 L 0 0 L 100 80 Z');

    const star = presetGeometrySvgPath('star5', 100, 100);
    expect(star?.fillMode).toBe('norm');
    // 10 个顶点的闭合多边形,首点在正上方。
    expect(star?.path.startsWith('M 50 0 ')).toBe(true);
    expect(star?.path.split('L ')).toHaveLength(10);
    expect(star?.path.endsWith('Z')).toBe(true);

    const diag = presetGeometrySvgPath('round2DiagRect', 200, 100);
    // 左上/右下圆角(默认 16667 → 16.667),右上/左下直角。
    expect(diag?.path.startsWith('M 16.667 0 ')).toBe(true);
    expect(diag?.path).toContain('L 200 0');
  });

  it('builds wedge callouts with the tail merged into the facing edge', () => {
    // 默认 adj1=-20833、adj2=62500 → 尾巴顶点在框体下方偏左。
    const rect = presetGeometrySvgPath('wedgeRectCallout', 200, 100);
    expect(rect?.fillMode).toBe('norm');
    expect(rect?.path).toContain('L 58.334 112.5');
    expect(rect?.path.endsWith('Z')).toBe(true);

    // 圆角变体带 Q 圆角段;顶点在框内时退化为普通圆角矩形。
    const round = presetGeometrySvgPath('wedgeRoundRectCallout', 200, 100, {
      adj1: 0,
      adj2: 0,
      adj3: 16_667,
    });
    expect(round?.path).toContain('Q 200 0 200 16.667');
    expect(round?.path).not.toContain('112.5');
  });

  it('returns undefined for CSS-rendered and unknown presets', () => {
    expect(presetGeometrySvgPath('rect', 100, 100)).toBeUndefined();
    expect(presetGeometrySvgPath('roundRect', 100, 100)).toBeUndefined();
    expect(presetGeometrySvgPath('cloudCallout', 100, 100)).toBeUndefined();
    expect(isSvgPathPresetGeometry('roundRect')).toBe(false);
    expect(isSvgPathPresetGeometry('rightArrow')).toBe(true);
  });
});

describe('NATIVE_V2_SUPPORTED_PRESET_GEOMETRIES', () => {
  it('is the union of CSS-rendered presets and SVG path presets', () => {
    for (const preset of CSS_RENDERED_PRESET_GEOMETRIES) {
      expect(NATIVE_V2_SUPPORTED_PRESET_GEOMETRIES.has(preset)).toBe(true);
    }
    for (const preset of NATIVE_V2_SUPPORTED_PRESET_GEOMETRIES) {
      expect(CSS_RENDERED_PRESET_GEOMETRIES.has(preset) || isSvgPathPresetGeometry(preset)).toBe(
        true,
      );
    }
  });
});
