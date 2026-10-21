import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import type { PptxBinaryAsset } from '@reachany/importer/pptx';

import {
  isStorableReachDeckPptxAsset,
  normalizeReachDeckPptxAsset,
} from '../../lib/reach-deck/pptx-media.js';
import { convertReachDeckPptxMetafile } from '../../lib/reach-deck/pptx-metafile.js';

vi.mock('../../lib/reach-deck/pptx-metafile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/pptx-metafile.js')>()),
  convertReachDeckPptxMetafile: vi.fn(),
}));

const asset = (bytes: Uint8Array, contentType: string): PptxBinaryAsset => ({
  partPath: '/ppt/media/image1',
  contentType,
  byteLength: bytes.byteLength,
  digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  bytes,
});

const solid = async (
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'gif',
): Promise<Uint8Array> => {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 120, b: 220 } },
  });
  const encoded = await (
    format === 'png' ? image.png() : format === 'jpeg' ? image.jpeg() : image.gif()
  ).toBuffer();
  return new Uint8Array(encoded);
};

const dimensionsOf = async (bytes: Uint8Array): Promise<{ width: number; height: number }> => {
  const metadata = await sharp(Buffer.from(bytes)).metadata();
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 };
};

describe('PPTX import media normalization', () => {
  it('stores a small supported image byte-identical', async () => {
    const bytes = await solid(320, 200, 'png');

    const normalized = await normalizeReachDeckPptxAsset(asset(bytes, 'image/png'));

    expect(normalized).toEqual({ bytes, contentType: 'image/png' });
  });

  it('downscales an oversized raster to the stage resolution as WebP', async () => {
    const bytes = await solid(6240, 4160, 'png');

    const normalized = await normalizeReachDeckPptxAsset(asset(bytes, 'image/png'));

    expect(normalized?.contentType).toBe('image/webp');
    expect(await dimensionsOf(normalized!.bytes)).toEqual({ width: 2880, height: 1920 });
    // The point of the exercise: a slide image that no longer costs megabytes.
    expect(normalized!.bytes.byteLength).toBeLessThan(bytes.byteLength / 4);
  });

  it('re-encodes a type the native model cannot carry', async () => {
    const bytes = await solid(400, 300, 'gif');

    const normalized = await normalizeReachDeckPptxAsset(asset(bytes, 'image/gif'));

    expect(normalized?.contentType).toBe('image/webp');
    expect(await dimensionsOf(normalized!.bytes)).toEqual({ width: 400, height: 300 });
  });

  it('keeps a converted metafile raster byte-identical while it fits the media limit', async () => {
    const bytes = await solid(900, 600, 'png');
    vi.mocked(convertReachDeckPptxMetafile).mockResolvedValueOnce({
      bytes,
      contentType: 'image/png',
    });

    const normalized = await normalizeReachDeckPptxAsset(asset(bytes, 'image/x-wmf'));

    expect(normalized).toEqual({ bytes, contentType: 'image/png' });
  });

  it('normalizes a converted metafile raster that outgrows the media limit', async () => {
    // A 3× raster of a full-page metafile: stored PNG, so its bytes are the
    // uncompressed image and land well past the generated-media 10MB cap.
    const oversized = new Uint8Array(
      await sharp({
        create: { width: 3200, height: 3200, channels: 3, background: { r: 8, g: 8, b: 8 } },
      })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    );
    expect(oversized.byteLength).toBeGreaterThan(10 * 1024 * 1024);
    vi.mocked(convertReachDeckPptxMetafile).mockResolvedValueOnce({
      bytes: oversized,
      contentType: 'image/png',
    });

    const normalized = await normalizeReachDeckPptxAsset(asset(oversized, 'image/x-wmf'));

    // Uploading the raw raster would throw and fail the entire import, so the
    // picture has to arrive downscaled rather than not at all.
    expect(normalized?.contentType).toBe('image/webp');
    expect(await dimensionsOf(normalized!.bytes)).toEqual({ width: 2880, height: 2880 });
    expect(normalized!.bytes.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it('rasterizes an SVG part so a vector-only picture still reaches the deck', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="orange"/></svg>',
    );

    const normalized = await normalizeReachDeckPptxAsset(asset(svg, 'image/svg+xml'));

    expect(normalized?.contentType).toBe('image/png');
    expect(await dimensionsOf(normalized!.bytes)).toEqual({ width: 1024, height: 1024 });
  });

  it('omits assets it cannot decode, leaving the mapper to report the loss', async () => {
    expect(await normalizeReachDeckPptxAsset(asset(new Uint8Array(), 'image/png'))).toBeUndefined();
    expect(
      await normalizeReachDeckPptxAsset(asset(new Uint8Array([1, 2, 3, 4]), 'image/png')),
    ).toBeUndefined();
    // Metafiles and SVG parts are eligible — they take the vector conversion
    // path — while a type nothing can decode is not.
    expect(isStorableReachDeckPptxAsset(asset(new Uint8Array([1]), 'image/x-wmf'))).toBe(true);
    expect(isStorableReachDeckPptxAsset(asset(new Uint8Array([1]), 'image/svg+xml'))).toBe(true);
    expect(isStorableReachDeckPptxAsset(asset(new Uint8Array([1]), 'image/x-pict'))).toBe(false);
  });
});
