import { describe, expect, it } from 'vitest';

import { DEFAULT_PPTX_PARSE_LIMITS, resolvePptxParseLimits } from '../src/pptx/index.js';

describe('PPTX parser limits', () => {
  it('exposes conservative immutable defaults and permits narrower overrides', () => {
    expect(Object.isFrozen(DEFAULT_PPTX_PARSE_LIMITS)).toBe(true);

    const resolved = resolvePptxParseLimits({ maxInputBytes: 1024 });
    expect(resolved.maxInputBytes).toBe(1024);
    expect(resolved.maxArchiveEntries).toBe(DEFAULT_PPTX_PARSE_LIMITS.maxArchiveEntries);
  });

  it('rejects invalid or internally inconsistent limits', () => {
    expect(() => resolvePptxParseLimits({ maxInputBytes: 0 })).toThrow(/positive integer/i);
    expect(() => resolvePptxParseLimits({ maxEntryBytes: 2048, maxExpandedBytes: 1024 })).toThrow(
      /maxEntryBytes/i,
    );
    expect(() => resolvePptxParseLimits({ maxXmlNodes: 10, maxTotalXmlNodes: 9 })).toThrow(
      /maxXmlNodes/i,
    );
  });
});
