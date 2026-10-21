import { describe, expect, it } from 'vitest';

import {
  canonicalizePptxPartPath,
  createPptxSourceDigest,
  createStablePptxId,
} from '../src/pptx/index.js';

describe('PPTX source identity', () => {
  it('normalizes safe package part paths', () => {
    expect(canonicalizePptxPartPath('ppt/slides/../slides/slide1.xml')).toBe(
      '/ppt/slides/slide1.xml',
    );
    expect(canonicalizePptxPartPath('/ppt/media/image1.png')).toBe('/ppt/media/image1.png');
  });

  it('rejects paths that escape the package or use non-package schemes', () => {
    expect(() => canonicalizePptxPartPath('../../outside.xml')).toThrow(/package root/i);
    expect(() => canonicalizePptxPartPath('https://example.test/image.png')).toThrow(/scheme/i);
    expect(() => canonicalizePptxPartPath('ppt\\slides\\slide1.xml')).toThrow(/backslash/i);
  });

  it('creates deterministic versioned IDs without random or time input', () => {
    const first = createStablePptxId('shape', [
      '/ppt/slides/slide1.xml',
      '42',
      '/p:sld/p:cSld/p:spTree/p:sp[1]',
    ]);
    const second = createStablePptxId('shape', [
      '/ppt/slides/slide1.xml',
      '42',
      '/p:sld/p:cSld/p:spTree/p:sp[1]',
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^pptx-shape-v1-[a-f0-9]{32}$/);
    expect(
      createStablePptxId('shape', [
        '/ppt/slides/slide1.xml',
        '43',
        '/p:sld/p:cSld/p:spTree/p:sp[1]',
      ]),
    ).not.toBe(first);
  });

  it('digests bytes without text decoding', () => {
    expect(createPptxSourceDigest(new Uint8Array([0, 255, 1]))).toBe(
      'sha256:47ffa3ea45a70b8a41c2c0825df323c00a8b7a01c1ea06083cc41dddcc001123',
    );
  });
});
