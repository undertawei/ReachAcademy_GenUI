import { describe, expect, it } from 'vitest';

import { defaultTweenForEffect } from '../src/nativeAnimationDefaults.js';

describe('native animation defaults', () => {
  it('creates explicit strict endpoints for text color animations', () => {
    expect(defaultTweenForEffect('color', 'textFrame')).toEqual({
      from: { color: '#172024' },
      to: { color: '#2563EB' },
    });
  });
});
