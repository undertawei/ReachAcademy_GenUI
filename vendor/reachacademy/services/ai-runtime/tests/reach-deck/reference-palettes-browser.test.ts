import { describe, expect, it } from 'vitest';
import { type ReachDeckDesignContext } from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '@reachany/reach-deck-dsl/reference-library';
import { compileHtmlLayout } from '../../lib/reach-deck/html-layout';

const luminance = (hex: string) =>
  [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
const contrast = (a: string, b: string) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
};

describe('every reference palette in actual Chromium composition', () => {
  it.each(REFERENCE_LIBRARY.palettes.map((palette) => [palette.id, palette] as const))(
    '%s checks actual text uses and preserves explicitly adjusted colors',
    async (id, palette) => {
      const original = { ...palette.colors };
      const context: ReachDeckDesignContext = {
        schemaVersion: 'reach-deck-design-context/v1',
        libraryVersion: REFERENCE_LIBRARY_VERSION,
        librarySha256: REFERENCE_LIBRARY_SHA256,
        paletteReferenceId: id,
        imageStyleReferenceIds: [],
        visualIntent: 'Palette readability verification',
        resolvedColors: { ...original },
      };
      // Small labels may use any semantic token; each is measured on its actual carrier.
      const uses = (['ink', 'muted', 'accent', 'success', 'warning'] as const).map(
        (key, index) => ({
          key,
          background: index % 2 ? original.surface : original.background,
        }),
      );
      const compile = (designContext: ReachDeckDesignContext) =>
        compileHtmlLayout({
          pageId: id,
          themeName: 'reach-classic',
          designContext,
          assets: [],
          html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:${original.background}">${uses
            .map(
              ({ key, background }, index) =>
                `<p id="${key}" style="position:absolute;left:100px;top:${80 + index * 140}px;width:1200px;height:80px;margin:0;background:${background};color:${designContext.resolvedColors[key]};font:20px/32px Arial">Readable ${key} evidence</p>`,
            )
            .join('')}</section></body></html>`,
        });
      const unsafe = uses.filter(
        ({ key, background }) => contrast(original[key], background) < 4.5,
      );
      if (unsafe.length) {
        const unadjusted = await compile(context);
        expect(
          unadjusted.slide.elements.filter((element) => element.type === 'textFrame'),
        ).toHaveLength(5);
        for (const { key } of unsafe) {
          expect(unadjusted.diagnostics).toEqual(
            expect.arrayContaining([expect.stringContaining(`CONTRAST_LOW: ${key} `)]),
          );
        }
        for (const { key, background } of unsafe) {
          context.resolvedColors[key] =
            contrast('#000000', background) > contrast('#ffffff', background)
              ? '#000000'
              : '#ffffff';
        }
      }
      const compiled = await compile(context);
      expect(compiled.diagnostics.join('\n')).not.toContain('CONTRAST_LOW');
      expect(
        compiled.slide.elements.filter((element) => element.type === 'textFrame'),
      ).toHaveLength(5);
      expect(context.paletteReferenceId).toBe(id);
      expect(palette.colors).toEqual(original);
      for (const { key, background } of uses) {
        expect(contrast(context.resolvedColors[key], background)).toBeGreaterThanOrEqual(4.5);
      }
    },
    60_000,
  );
});
