export const MAIC_IMPORTER_VERSION = '0.3.5';
export const MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION = 'maic-reach-deck-v2-mapping/v1' as const;

export const MAIC_IMPORT_LIMITS = Object.freeze({
  maxSourceBytes: 5 * 1024 * 1024,
  maxPages: 200,
  maxElementsPerPage: 2_000,
  maxStringCharacters: 1_000_000,
  maxNestingDepth: 64,
  maxJsonValues: 100_000,
  maxInteractiveHtmlBytes: 512 * 1024,
});

export interface MaicImportLimits {
  maxSourceBytes: number;
  maxPages: number;
  maxElementsPerPage: number;
  maxStringCharacters: number;
  maxNestingDepth: number;
  maxJsonValues: number;
  maxInteractiveHtmlBytes: number;
}
