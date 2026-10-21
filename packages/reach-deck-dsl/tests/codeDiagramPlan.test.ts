import { describe, expect, it } from 'vitest';
import { parsePlannedVisualAsset } from '../src/generationTypes.js';

const plan = {
  kind: 'diagram',
  representation: 'code',
  format: 'jpg',
  purpose: 'Show motion',
  alt: 'Moving particles',
  aspectRatio: '16:9',
  placement: 'primary',
  prompt: 'Draw a particle distribution',
  invariants: ['Particle count remains constant'],
};

describe('code diagram production plans', () => {
  it('keeps an explicit static JPG plan', () => {
    expect(parsePlannedVisualAsset(plan)).toEqual(plan);
  });
  it('requires explicit bounded animation parameters for GIF', () => {
    const gif = { ...plan, format: 'gif', durationSeconds: 4, fps: 10 };
    expect(parsePlannedVisualAsset(gif)).toEqual(gif);
    expect(parsePlannedVisualAsset({ ...gif, durationSeconds: 8, fps: 15 })).toMatchObject({
      fps: 15,
    });
    for (const invalid of [
      { ...plan, format: 'gif' },
      { ...gif, durationSeconds: undefined },
      { ...gif, fps: undefined },
      { ...gif, durationSeconds: 0 },
      { ...gif, durationSeconds: 9 },
      { ...gif, fps: 0 },
      { ...gif, fps: 16 },
      { ...gif, fps: 1.5 },
      { ...gif, durationSeconds: 0.05, fps: 10 },
      { ...plan, durationSeconds: 4 },
      { ...plan, fps: 10 },
      { ...plan, durationSeconds: null, fps: null },
    ])
      expect(() => parsePlannedVisualAsset(invalid)).toThrow();
  });
  it.each([
    'plot',
    'spec',
    'states',
    'anchors',
    'scientificAnchor',
    'scientificModel',
    'stateBindings',
    'quantitativeSpec',
  ])('rejects code plans carrying typed quantitative or scientific state field %s', (field) => {
    expect(() => parsePlannedVisualAsset({ ...plan, [field]: {} })).toThrow();
  });
  it('rejects retired top-level routes without silently converting them', () => {
    for (const kind of ['function-plot', 'boardwriting', 'code'])
      expect(() => parsePlannedVisualAsset({ ...plan, kind })).toThrow();
  });
});
