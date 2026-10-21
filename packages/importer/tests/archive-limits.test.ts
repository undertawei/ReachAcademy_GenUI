import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import { readPptxPackage } from '../src/pptx/index.js';

const createZip = async (entries: readonly (readonly [string, string])[]): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, contents] of entries) await writer.add(name, new TextReader(contents));
  return writer.close();
};

const forgeDeclaredUncompressedSize = (input: Uint8Array, size: number): Uint8Array => {
  const output = input.slice();
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  for (let offset = 0; offset <= output.byteLength - 28; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint32(offset + 22, size, true);
    if (signature === 0x02014b50) view.setUint32(offset + 24, size, true);
  }
  return output;
};

describe('bounded PPTX package reading', () => {
  it('returns canonical entries and their actual digests', async () => {
    const bytes = await createZip([['ppt/presentation.xml', '<p:presentation/>']]);
    const result = await readPptxPackage(bytes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      partPath: '/ppt/presentation.xml',
      byteLength: 17,
    });
    expect(result.entries[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects entries whose declared or actual size exceeds the configured bound', async () => {
    const bytes = await createZip([['ppt/presentation.xml', '0123456789']]);
    const result = await readPptxPackage(bytes, { maxEntryBytes: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'pptx.package.entry_too_large', severity: 'fatal' }),
    );
  });

  it('rejects package-root traversal instead of normalizing it away', async () => {
    const bytes = await createZip([['../outside.xml', '<outside/>']]);
    const result = await readPptxPackage(bytes);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: 'pptx.package.unsafe_part_path',
      severity: 'fatal',
    });
  });

  it('stops extraction when actual output exceeds a forged declared size', async () => {
    const bytes = await createZip([['ppt/presentation.xml', 'x'.repeat(4096)]]);
    const forged = forgeDeclaredUncompressedSize(bytes, 1);
    const result = await readPptxPackage(forged, { maxEntryBytes: 64 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('pptx.package.entry_too_large');
    }
  });

  it('checks compression ratio against actual output instead of forged directory metadata', async () => {
    const bytes = await createZip([['ppt/presentation.xml', 'x'.repeat(4096)]]);
    const forged = forgeDeclaredUncompressedSize(bytes, 1);
    const result = await readPptxPackage(forged, {
      maxEntryBytes: 8192,
      maxCompressionRatio: 2,
      compressionRatioFloorBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('pptx.package.compression_ratio_exceeded');
    }
  });

  it('exempts small entries from the ratio check (legit EMF/XML compress >100x)', async () => {
    const bytes = await createZip([['ppt/presentation.xml', 'x'.repeat(4096)]]);
    const result = await readPptxPackage(bytes, {
      maxEntryBytes: 8192,
      maxCompressionRatio: 2,
      compressionRatioFloorBytes: 8192,
    });

    expect(result.ok).toBe(true);
  });
});
