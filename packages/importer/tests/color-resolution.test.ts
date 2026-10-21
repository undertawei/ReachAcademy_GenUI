import { describe, expect, it } from 'vitest';

import {
  applyPptxColorModifiers,
  createPptxSchemeColorContext,
  mapPptxSchemeToken,
  resolvePptxColor,
} from '../src/pptx/style/color-resolution.js';
import { pptxPercentage } from '../src/pptx/model/units.js';

const modifier = (kind: string, value: number) => ({ kind, value: pptxPercentage(value) });

describe('OOXML color modifier math', () => {
  it('applies linear-space tint and shade deterministically', () => {
    const tinted = applyPptxColorModifiers('#4874CB', [modifier('tint', 50_000)]);
    expect(tinted).toMatchObject({ ok: true, color: { alpha: 1 } });
    if (!tinted.ok) return;
    // Mixing toward white must brighten every channel.
    expect(tinted.color.hex > '#4874CB').toBe(true);

    const shaded = applyPptxColorModifiers('#4874CB', [modifier('shade', 50_000)]);
    if (!shaded.ok) throw new Error('shade failed');
    expect(shaded.color.hex < '#4874CB').toBe(true);

    const identity = applyPptxColorModifiers('#4874CB', [
      modifier('tint', 100_000),
      modifier('shade', 100_000),
    ]);
    expect(identity).toMatchObject({ ok: true, color: { hex: '#4874CB' } });
  });

  it('tracks alpha modifiers separately from the base color', () => {
    const result = applyPptxColorModifiers('#112233', [
      modifier('alpha', 60_000),
      modifier('alphaOff', 20_000),
    ]);
    expect(result).toMatchObject({ ok: true, color: { hex: '#112233', alpha: 0.8 } });
  });

  it('fails on unknown modifiers instead of skipping them', () => {
    const result = applyPptxColorModifiers('#112233', [modifier('gamma', 1)]);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects malformed base colors', () => {
    expect(applyPptxColorModifiers('nope', [])).toMatchObject({ ok: false });
  });
});

describe('scheme color resolution', () => {
  const context = createPptxSchemeColorContext(
    {
      colorScheme: {
        colors: {
          dk1: { token: 'dk1', sourceKind: 'srgb', value: '#000000' },
          lt1: { token: 'lt1', sourceKind: 'srgb', value: '#FFFFFF' },
          accent1: { token: 'accent1', sourceKind: 'srgb', value: '#4874CB' },
        },
      },
    },
    { tx1: 'dk1', bg1: 'lt1' },
  );

  it('maps tokens through the master color map into theme values', () => {
    expect(mapPptxSchemeToken('tx1', context)).toBe('dk1');
    const resolved = resolvePptxColor({ kind: 'scheme', token: 'bg1', modifiers: [] }, context);
    expect(resolved).toMatchObject({ ok: true, color: { hex: '#FFFFFF', alpha: 1 } });
  });

  it('honors slide/layout override maps ahead of the master map', () => {
    const overridden = { ...context, colorMapOverride: { tx1: 'accent1' } };
    const resolved = resolvePptxColor({ kind: 'scheme', token: 'tx1', modifiers: [] }, overridden);
    expect(resolved).toMatchObject({ ok: true, color: { hex: '#4874CB' } });
  });

  it('substitutes phClr from the style matrix reference color', () => {
    const resolved = resolvePptxColor(
      { kind: 'scheme', token: 'phClr', modifiers: [modifier('shade', 50_000)] },
      context,
      { placeholderColor: { hex: '#4874CB', alpha: 0.5 } },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.color.alpha).toBe(0.5);
    expect(resolved.color.hex < '#4874CB').toBe(true);
  });

  it('fails on unknown scheme tokens and missing phClr context', () => {
    expect(
      resolvePptxColor({ kind: 'scheme', token: 'accent9', modifiers: [] }, context),
    ).toMatchObject({ ok: false });
    expect(
      resolvePptxColor({ kind: 'scheme', token: 'phClr', modifiers: [] }, context),
    ).toMatchObject({ ok: false });
  });
});
