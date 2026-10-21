import { describe, expect, it } from 'vitest';

import {
  decodeReachDeckGeneratedImage,
  normalizeReachDeckSpeechAudio,
} from '../../lib/reach-deck/generated-media.js';

describe('Reach Deck generated media normalization', () => {
  it('decodes a PNG b64_json payload for durable storage', () => {
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const result = decodeReachDeckGeneratedImage({
      base64: Buffer.from(pngHeader).toString('base64'),
    });

    expect(result.contentType).toBe('image/png');
    expect(Array.from(result.bytes)).toEqual(Array.from(pngHeader));
  });

  it('rejects URL-only image output instead of fetching an untrusted provider URL', () => {
    expect(() =>
      decodeReachDeckGeneratedImage({ url: 'https://provider.example/generated.png' }),
    ).toThrow('must return b64_json');
  });

  it('normalizes generic speech content type from the requested response format', () => {
    expect(
      normalizeReachDeckSpeechAudio(
        { bytes: new Uint8Array([73, 68, 51]), contentType: 'application/octet-stream' },
        'mp3',
      ),
    ).toMatchObject({ contentType: 'audio/mpeg' });
  });
});
