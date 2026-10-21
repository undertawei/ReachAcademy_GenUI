import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { PptxBinaryAsset } from '@reachany/importer/pptx';

import {
  convertReachDeckPptxMetafile,
  convertReachDeckPptxSvg,
  ensureSvgNamespace,
  isReachDeckPptxMetafile,
  isReachDeckPptxSvg,
  rasterizeReachDeckMetafileSvg,
} from '../../lib/reach-deck/pptx-metafile.js';

const asset = (bytes: Uint8Array, contentType: string): PptxBinaryAsset => ({
  partPath: '/ppt/media/image1.wmf',
  contentType,
  byteLength: bytes.byteLength,
  digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  bytes,
});

const svgAsset = (markup: string): PptxBinaryAsset =>
  asset(new TextEncoder().encode(markup), 'image/svg+xml');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe('PPTX metafile conversion', () => {
  let emptyFontDirectory: string;

  afterEach(async () => {
    if (emptyFontDirectory !== undefined) {
      await rm(emptyFontDirectory, { recursive: true, force: true });
    }
  });

  it('recognises the content types PowerPoint writes for metafiles', () => {
    expect(isReachDeckPptxMetafile('image/x-wmf')).toBe(true);
    expect(isReachDeckPptxMetafile('image/x-emf')).toBe(true);
    expect(isReachDeckPptxMetafile('IMAGE/X-EMF')).toBe(true);
    expect(isReachDeckPptxMetafile('image/png')).toBe(false);
  });

  it('gives libwmf output the namespace every renderer requires', () => {
    // libwmf declares only xmlns:sodipodi on the root, which resvg rejects.
    const fromLibwmf =
      '<?xml version="1.0"?><svg width="768" height="271" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"><line x1="0" y1="0" x2="1" y2="1"/></svg>';
    expect(ensureSvgNamespace(fromLibwmf)).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="768"',
    );
    // emf2svg already declares it; nothing to add.
    const fromEmf2svg = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="1"/>';
    expect(ensureSvgNamespace(fromEmf2svg)).toBe(fromEmf2svg);
  });

  it('rasterizes a converted metafile at the stage scale without host fonts', async () => {
    emptyFontDirectory = await mkdtemp(path.join(tmpdir(), 'reach-deck-no-fonts-'));
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="red"/><text x="5" y="30" font-family="Symbol">abg</text></svg>';

    const raster = await rasterizeReachDeckMetafileSvg(svg, emptyFontDirectory);

    expect(raster?.contentType).toBe('image/png');
    expect([...raster!.bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    // 3× the metafile's own size: 100×40 → 300×120, read from the IHDR chunk.
    const view = new DataView(raster!.bytes.buffer, raster!.bytes.byteOffset);
    expect(view.getUint32(16)).toBe(300);
    expect(view.getUint32(20)).toBe(120);
  });

  it('recognises the SVG content type, parameters and all', () => {
    expect(isReachDeckPptxSvg('image/svg+xml')).toBe(true);
    expect(isReachDeckPptxSvg('IMAGE/SVG+XML; charset=utf-8')).toBe(true);
    expect(isReachDeckPptxSvg('image/png')).toBe(false);
  });

  it('scales a small SVG icon up to the target edge instead of its own 24px box', async () => {
    const raster = await convertReachDeckPptxSvg(
      svgAsset(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12" fill="blue"/></svg>',
      ),
    );

    expect(raster?.contentType).toBe('image/png');
    expect([...raster!.bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
    // 24×12 scaled by 1024/24, read from the IHDR chunk.
    const view = new DataView(raster!.bytes.buffer, raster!.bytes.byteOffset);
    expect(view.getUint32(16)).toBe(1024);
    expect(view.getUint32(20)).toBe(512);
  });

  it('leaves an SVG already larger than the target edge at its own size', async () => {
    const raster = await convertReachDeckPptxSvg(
      svgAsset(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="green"/></svg>',
      ),
    );

    const view = new DataView(raster!.bytes.buffer, raster!.bytes.byteOffset);
    expect(view.getUint32(16)).toBe(1600);
    expect(view.getUint32(20)).toBe(900);
  });

  it('declines SVG bytes it cannot read instead of throwing', async () => {
    expect(await convertReachDeckPptxSvg(asset(new Uint8Array([1]), 'image/png'))).toBe(undefined);
    expect(await convertReachDeckPptxSvg(svgAsset(''))).toBe(undefined);
    expect(await convertReachDeckPptxSvg(svgAsset('<svg>unterminated'))).toBe(undefined);
    // Not valid UTF-8 at all.
    expect(
      await convertReachDeckPptxSvg(asset(new Uint8Array([0xff, 0xfe]), 'image/svg+xml')),
    ).toBe(undefined);
  });

  it('declines what it cannot convert instead of throwing', async () => {
    // Not a metafile at all.
    expect(await convertReachDeckPptxMetafile(asset(new Uint8Array([1]), 'image/png'))).toBe(
      undefined,
    );
    // Empty bytes.
    expect(await convertReachDeckPptxMetafile(asset(new Uint8Array(), 'image/x-wmf'))).toBe(
      undefined,
    );
    // Garbage bytes: whether the converter is installed on this machine or not,
    // the answer is "keep reporting the picture as lost", never an exception.
    expect(
      await convertReachDeckPptxMetafile(asset(new Uint8Array([1, 2, 3, 4]), 'image/x-wmf')),
    ).toBe(undefined);
  });
});
