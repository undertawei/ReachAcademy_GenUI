import { Uint8ArrayReader, Writer, ZipReader, type Entry } from '@zip.js/zip.js';

import type { PptxDiagnostic } from '../diagnostics.js';
import {
  canonicalizePptxPartPath,
  createPptxSourceDigest,
  type PptxSourceDigest,
} from '../identity.js';
import { resolvePptxParseLimits, type PptxParseLimits } from '../options.js';

export interface PptxPackageEntry {
  partPath: string;
  byteLength: number;
  compressedByteLength: number;
  digest: PptxSourceDigest;
  bytes: Uint8Array;
}

export interface PptxPackageReadSuccess {
  ok: true;
  sourceDigest: PptxSourceDigest;
  entries: readonly PptxPackageEntry[];
}

export interface PptxPackageReadFailure {
  ok: false;
  diagnostics: readonly PptxDiagnostic[];
}

export type PptxPackageReadResult = PptxPackageReadSuccess | PptxPackageReadFailure;

const fatalPackageDiagnostic = (
  code: `pptx.package.${string}`,
  message: string,
  partPath?: string,
): PptxPackageReadFailure => ({
  ok: false,
  diagnostics: [
    {
      code,
      severity: 'fatal',
      feature: 'package',
      message,
      ...(partPath ? { location: { partPath } } : {}),
    },
  ],
});

const validateEntryMetadata = (
  entry: Entry,
  limits: Readonly<PptxParseLimits>,
): PptxPackageReadFailure | undefined => {
  if (entry.encrypted) {
    return fatalPackageDiagnostic(
      'pptx.package.encrypted_entry',
      `Encrypted package entry is not supported: ${entry.filename}`,
    );
  }
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    return fatalPackageDiagnostic(
      'pptx.package.entry_too_large',
      `Package entry exceeds maxEntryBytes: ${entry.filename}`,
    );
  }
  const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
  if (
    entry.uncompressedSize > limits.compressionRatioFloorBytes &&
    ratio > limits.maxCompressionRatio
  ) {
    return fatalPackageDiagnostic(
      'pptx.package.compression_ratio_exceeded',
      `Package entry exceeds maxCompressionRatio: ${entry.filename}`,
    );
  }
  return undefined;
};

class PptxArchiveLimitError extends Error {
  constructor(
    readonly code: `pptx.package.${string}`,
    message: string,
  ) {
    super(message);
    this.name = 'PptxArchiveLimitError';
  }
}

class BoundedUint8ArrayWriter extends Writer<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;
  private limitFailure: PptxArchiveLimitError | undefined;

  constructor(
    private readonly maxEntryBytes: number,
    private readonly maxRemainingExpandedBytes: number,
    private readonly partPath: string,
  ) {
    super();
  }

  override async init(size?: number): Promise<void> {
    if (size !== undefined) this.assertWithinLimits(size);
    await super.init?.(size);
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    this.assertWithinLimits(this.byteLength + array.byteLength);
    this.chunks.push(array.slice());
    this.byteLength += array.byteLength;
  }

  override async getData(): Promise<Uint8Array> {
    const output = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  getLimitFailure(): PptxArchiveLimitError | undefined {
    return this.limitFailure;
  }

  private assertWithinLimits(size: number): void {
    if (size > this.maxEntryBytes) {
      this.limitFailure = new PptxArchiveLimitError(
        'pptx.package.entry_too_large',
        `Package entry exceeds maxEntryBytes during extraction: ${this.partPath}`,
      );
      throw this.limitFailure;
    }
    if (size > this.maxRemainingExpandedBytes) {
      this.limitFailure = new PptxArchiveLimitError(
        'pptx.package.expanded_size_exceeded',
        'PPTX package exceeds maxExpandedBytes during extraction.',
      );
      throw this.limitFailure;
    }
  }
}

export const readPptxPackage = async (
  input: Uint8Array,
  limitOverrides: Partial<PptxParseLimits> = {},
): Promise<PptxPackageReadResult> => {
  const limits = resolvePptxParseLimits(limitOverrides);
  if (input.byteLength > limits.maxInputBytes) {
    return fatalPackageDiagnostic(
      'pptx.package.input_too_large',
      'PPTX input exceeds maxInputBytes.',
    );
  }

  const reader = new ZipReader(new Uint8ArrayReader(input));
  try {
    const fileEntries: Entry[] = [];
    for await (const entry of reader.getEntriesGenerator()) {
      if (entry.directory) continue;
      fileEntries.push(entry);
      if (fileEntries.length > limits.maxArchiveEntries) {
        return fatalPackageDiagnostic(
          'pptx.package.too_many_entries',
          'PPTX package exceeds maxArchiveEntries.',
        );
      }
    }

    let declaredExpandedBytes = 0;
    let actualExpandedBytes = 0;
    const seenPartPaths = new Set<string>();
    const entries: PptxPackageEntry[] = [];

    for (const entry of fileEntries) {
      const metadataFailure = validateEntryMetadata(entry, limits);
      if (metadataFailure) return metadataFailure;

      let partPath: string;
      try {
        partPath = canonicalizePptxPartPath(entry.filename);
      } catch (error) {
        return fatalPackageDiagnostic(
          'pptx.package.unsafe_part_path',
          error instanceof Error ? error.message : 'PPTX package contains an unsafe part path.',
        );
      }

      const collisionKey = partPath.toLowerCase();
      if (seenPartPaths.has(collisionKey)) {
        return fatalPackageDiagnostic(
          'pptx.package.duplicate_part',
          `PPTX package contains a duplicate or case-colliding part: ${partPath}`,
          partPath,
        );
      }
      seenPartPaths.add(collisionKey);

      declaredExpandedBytes += entry.uncompressedSize;
      if (declaredExpandedBytes > limits.maxExpandedBytes) {
        return fatalPackageDiagnostic(
          'pptx.package.expanded_size_exceeded',
          'PPTX package exceeds maxExpandedBytes.',
          partPath,
        );
      }

      if (!entry.getData) {
        return fatalPackageDiagnostic(
          'pptx.package.unreadable_entry',
          `PPTX package entry cannot be read: ${partPath}`,
          partPath,
        );
      }
      let bytes: Uint8Array;
      const writer = new BoundedUint8ArrayWriter(
        limits.maxEntryBytes,
        limits.maxExpandedBytes - actualExpandedBytes,
        partPath,
      );
      try {
        bytes = await entry.getData(writer, {
          checkSignature: true,
          preventClose: true,
        });
      } catch (error) {
        const limitFailure = writer.getLimitFailure();
        if (limitFailure) {
          return fatalPackageDiagnostic(limitFailure.code, limitFailure.message, partPath);
        }
        throw error;
      }
      if (bytes.byteLength > limits.maxEntryBytes) {
        return fatalPackageDiagnostic(
          'pptx.package.entry_too_large',
          `Package entry exceeds maxEntryBytes after extraction: ${partPath}`,
          partPath,
        );
      }
      if (
        bytes.byteLength > limits.compressionRatioFloorBytes &&
        bytes.byteLength / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio
      ) {
        return fatalPackageDiagnostic(
          'pptx.package.compression_ratio_exceeded',
          `Package entry exceeds maxCompressionRatio after extraction: ${partPath}`,
          partPath,
        );
      }
      if (bytes.byteLength !== entry.uncompressedSize) {
        return fatalPackageDiagnostic(
          'pptx.package.entry_size_mismatch',
          `Package entry size does not match its directory metadata: ${partPath}`,
          partPath,
        );
      }
      actualExpandedBytes += bytes.byteLength;

      entries.push({
        partPath,
        byteLength: bytes.byteLength,
        compressedByteLength: entry.compressedSize,
        digest: createPptxSourceDigest(bytes),
        bytes,
      });
    }

    entries.sort((left, right) =>
      left.partPath < right.partPath ? -1 : left.partPath > right.partPath ? 1 : 0,
    );
    return {
      ok: true,
      sourceDigest: createPptxSourceDigest(input),
      entries,
    };
  } catch (error) {
    return fatalPackageDiagnostic(
      'pptx.package.invalid_zip',
      error instanceof Error
        ? `Invalid PPTX ZIP package: ${error.message}`
        : 'Invalid PPTX ZIP package.',
    );
  } finally {
    await reader.close().catch(() => undefined);
  }
};
