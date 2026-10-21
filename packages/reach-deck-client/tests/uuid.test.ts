import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReachDeckUuid } from '../src/index.js';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createReachDeckUuid', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis.crypto as unknown as Record<string, unknown>).randomUUID;
  });

  it('uses the native randomUUID implementation when available', () => {
    const expected = '11111111-2222-4333-8444-555555555555';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(expected);

    expect(createReachDeckUuid()).toBe(expected);
  });

  it('generates an RFC 4122 v4 UUID when randomUUID is unavailable', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
      return array;
    });

    const result = createReachDeckUuid();

    expect(result).toBe('abababab-abab-4bab-abab-abababababab');
    expect(result).toMatch(UUID_V4_PATTERN);
  });
});
