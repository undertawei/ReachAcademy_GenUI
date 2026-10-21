export interface PptxParseLimits {
  maxInputBytes: number;
  maxArchiveEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  /**
   * Entries at or below this uncompressed size skip the ratio check: tiny
   * highly-compressible parts (EMF metafiles, XML) routinely exceed 100x
   * legitimately, and total expansion stays bounded by maxExpandedBytes.
   */
  compressionRatioFloorBytes: number;
  maxXmlDepth: number;
  maxXmlNodes: number;
  maxTotalXmlNodes: number;
  maxXmlTextBytes: number;
  maxRelationships: number;
  maxTotalRelationships: number;
  maxMediaAssets: number;
  maxMediaAssetBytes: number;
  maxTotalMediaBytes: number;
}

export const DEFAULT_PPTX_PARSE_LIMITS: Readonly<PptxParseLimits> = Object.freeze({
  // Real lesson decks routinely carry a few hundred MB of unscaled camera and
  // screenshot images; the media pipeline downscales them on import, so the
  // package bound only has to fit the upload itself.
  maxInputBytes: 250 * 1024 * 1024,
  maxArchiveEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
  compressionRatioFloorBytes: 16 * 1024 * 1024,
  maxXmlDepth: 128,
  maxXmlNodes: 1_000_000,
  maxTotalXmlNodes: 2_000_000,
  maxXmlTextBytes: 16 * 1024 * 1024,
  maxRelationships: 50_000,
  maxTotalRelationships: 100_000,
  maxMediaAssets: 1_000,
  maxMediaAssetBytes: 64 * 1024 * 1024,
  maxTotalMediaBytes: 256 * 1024 * 1024,
});

export const resolvePptxParseLimits = (
  overrides: Partial<PptxParseLimits> = {},
): Readonly<PptxParseLimits> => {
  const resolved: PptxParseLimits = { ...DEFAULT_PPTX_PARSE_LIMITS, ...overrides };

  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`PPTX parse limit ${name} must be a positive integer.`);
    }
  }
  if (resolved.maxEntryBytes > resolved.maxExpandedBytes) {
    throw new Error('PPTX maxEntryBytes cannot exceed maxExpandedBytes.');
  }
  if (resolved.maxMediaAssetBytes > resolved.maxTotalMediaBytes) {
    throw new Error('PPTX maxMediaAssetBytes cannot exceed maxTotalMediaBytes.');
  }
  if (resolved.maxXmlNodes > resolved.maxTotalXmlNodes) {
    throw new Error('PPTX maxXmlNodes cannot exceed maxTotalXmlNodes.');
  }
  if (resolved.maxRelationships > resolved.maxTotalRelationships) {
    throw new Error('PPTX maxRelationships cannot exceed maxTotalRelationships.');
  }

  return Object.freeze(resolved);
};
