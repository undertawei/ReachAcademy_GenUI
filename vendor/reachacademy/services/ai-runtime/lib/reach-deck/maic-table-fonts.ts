import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { create, type Font } from 'fontkit';
import type { PptxFontMetricsProvider } from '@reachany/importer/pptx';

const files = {
  'Source Han Sans VF': 'SourceHanSans-VF.ttf',
  'Source Han Serif SC': 'SourceHanSerifSC-Regular.otf',
  'LXGW WenKai': 'LXGWWenKai-Regular.ttf',
} as const;

let loading: Promise<PptxFontMetricsProvider> | undefined;

export async function resolveMaicTableFontDirectory(
  explicitDirectory = process.env.AI_RUNTIME_OFFICE_FONT_DIR?.trim(),
  cwd = process.cwd(),
): Promise<string> {
  // Runtime filesystem paths must not become Webpack module IDs via require.resolve.
  const candidates =
    explicitDirectory === undefined || explicitDirectory.length === 0
      ? [
          path.resolve(cwd, 'packages/reach-deck-player/fonts/sources'),
          path.resolve(cwd, '../../packages/reach-deck-player/fonts/sources'),
        ]
      : [path.resolve(explicitDirectory)];
  for (const candidate of candidates) {
    try {
      await Promise.all(Object.values(files).map((file) => access(path.join(candidate, file))));
      return candidate;
    } catch {
      // An explicit directory is authoritative; only default candidates may fall back.
    }
  }
  throw new Error('Required MAIC table fonts are unavailable.');
}

/** MAIC text uses these bundled substitutions; never resolve a source-supplied path. */
export function loadMaicTableFontMetrics(): Promise<PptxFontMetricsProvider> {
  loading ??= (async () => {
    const root = await resolveMaicTableFontDirectory();
    const fonts = new Map<string, Font>();
    for (const [family, file] of Object.entries(files)) {
      const bytes = await readFile(path.join(root, file));
      const font = create(bytes);
      if (!('layout' in font)) throw new Error(`Expected a single bundled font: ${family}`);
      fonts.set(family, font);
    }
    return {
      version: 'maic-fontkit-2.0.4/reach-fonts-2026-08-04/v1',
      measureText(request) {
        const font = fonts.get(request.family);
        if (!font) return undefined;
        const characters = Array.from(request.text);
        if (
          characters.some(
            (character) =>
              !/\s/u.test(character) && !font.hasGlyphForCodePoint(character.codePointAt(0)!),
          )
        ) {
          return undefined;
        }
        const weightAxis = font.variationAxes.wght;
        const weightedFont = weightAxis
          ? font.getVariation({
              wght: Math.min(weightAxis.max, Math.max(weightAxis.min, request.fontWeight)),
            })
          : font;
        const advanceWidthPt =
          (weightedFont.layout(request.text).advanceWidth * request.fontSizePt) / font.unitsPerEm +
          characters.length * request.letterSpacingPt;
        if (!Number.isFinite(advanceWidthPt)) return undefined;
        // CSS unitless line-height is based on em size, not ascender/descender bounds.
        return {
          advanceWidthPt: Math.max(0, advanceWidthPt),
          ascentPt: request.fontSizePt,
          descentPt: 0,
          lineGapPt: 0,
        };
      },
    } satisfies PptxFontMetricsProvider;
  })().catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
