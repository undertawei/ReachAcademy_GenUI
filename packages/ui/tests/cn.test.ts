import { describe, expect, it } from 'vitest';

import { cn } from '../src/cn';

describe('cn', () => {
  it('joins truthy class names with a single space', () => {
    expect(cn('rx-card', false, null, undefined, 'rx-card-elevated')).toBe(
      'rx-card rx-card-elevated',
    );
  });

  it('returns an empty string when called without values', () => {
    expect(cn()).toBe('');
  });

  it('returns an empty string when every value is falsy', () => {
    expect(cn('', false, null, undefined)).toBe('');
  });

  it('keeps multiple truthy class names in order', () => {
    expect(cn('rx-card', 'rx-card-muted', 'rx-card-compact')).toBe(
      'rx-card rx-card-muted rx-card-compact',
    );
  });
});
