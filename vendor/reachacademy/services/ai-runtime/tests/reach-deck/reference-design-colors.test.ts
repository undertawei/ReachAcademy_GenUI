import { describe, expect, it } from 'vitest';
import { ensureReferenceMutedContrast } from '../../lib/reach-deck/prompts/reference-design.js';
import type { ReachDeckDesignContext } from '@reachany/reach-deck-dsl';

const context = (background: string, surface: string, muted = '#806E65') =>
  ({
    schemaVersion: 'reach-deck-design-context/v1',
    libraryVersion: 'reference-library/v1',
    librarySha256: 'a'.repeat(64),
    paletteReferenceId: 'palette.test',
    imageStyleReferenceIds: [],
    visualIntent: 'test',
    resolvedColors: {
      background,
      surface,
      ink: '#382522',
      muted,
      accent: '#B53B35',
      success: '#28714D',
      warning: '#A15C20',
    },
  }) as ReachDeckDesignContext;

const luminance = (hex: string) =>
  [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
const ratio = (a: string, b: string) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('new reference run muted color normalization', () => {
  it('darkens muted only enough to pass 4.5:1 on background and surface', () => {
    const original = context('#F8F3E9', '#FFFDF8');
    const adjusted = ensureReferenceMutedContrast(original);
    expect(adjusted).not.toBe(original);
    expect(ratio(adjusted.resolvedColors.muted, '#F8F3E9')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(adjusted.resolvedColors.muted, '#FFFDF8')).toBeGreaterThanOrEqual(4.5);
    expect(adjusted.resolvedColors.muted).not.toBe('#000000');
    expect(original.resolvedColors.muted).toBe('#806E65');
  });

  it('leaves an already readable palette and its object identity unchanged', () => {
    const original = context('#FFFFFF', '#FFFFFF', '#444444');
    expect(ensureReferenceMutedContrast(original)).toBe(original);
  });
});
