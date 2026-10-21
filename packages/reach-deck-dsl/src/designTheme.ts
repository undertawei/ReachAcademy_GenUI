import {
  parseStoredReachDeckDesignContextValue,
  type ReachDeckDesignContext,
  type ReachDeckTypographyProfile,
} from './generationTypes.js';
import { resolveDeckTheme } from './deckThemes.js';
import type { DeckTheme } from './types.js';

/**
 * Bundled font pairing per typography profile. General keeps the calibrated Source Han Sans VF;
 * humanities pairs Source Han Serif SC titles with LXGW WenKai body text. Per-run glyph checks in
 * the layout compiler still fall back to Source Han Sans VF for uncovered characters.
 */
export function reachDeckTypographyFonts(profile: ReachDeckTypographyProfile | undefined): {
  fontDisplay: string;
  fontBody: string;
} {
  return profile === 'humanities'
    ? { fontDisplay: 'Source Han Serif SC', fontBody: 'LXGW WenKai' }
    : { fontDisplay: 'Source Han Sans VF', fontBody: 'Source Han Sans VF' };
}

/** Resolve a saved design snapshot without reselecting a palette or consulting source media. */
export function resolveDeckDesignTheme(
  themeName: string | undefined,
  designContext?: ReachDeckDesignContext,
): DeckTheme {
  if (designContext === undefined) return resolveDeckTheme(themeName);
  const design = parseStoredReachDeckDesignContextValue(designContext);
  return {
    name: `reference:${design.libraryVersion}:${design.paletteReferenceId || 'original'}`,
    ...design.resolvedColors,
    ...reachDeckTypographyFonts(design.typographyProfile),
  };
}
