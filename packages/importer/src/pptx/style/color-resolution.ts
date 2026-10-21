/**
 * Deterministic OOXML color resolution: scheme-token mapping plus the color
 * modifier math PowerPoint applies to `srgbClr`/`schemeClr`/`sysClr` values.
 *
 * The modifier formulas (linear-sRGB tint/shade, HSL lum/sat/hue adjustments)
 * are adapted from OpenMAIC's PPTX importer (`utils/color.ts`,
 * `serializer/StyleResolver.ts`) at commit
 * 63fc81d8e1e8e13d04106618ef29f713541a520e. OpenMAIC is distributed under the
 * MIT license; see THIRD_PARTY_NOTICES.md.
 */

import type { PptxColorIR, PptxColorModifierIR } from './drawing.js';
import type { PptxThemeStyleIR } from './theme.js';
import { ooxmlPercentageToRatio } from '../model/units.js';

export interface PptxSchemeColorContext {
  /** Theme color scheme values keyed by theme slot (dk1, lt1, accent1, ...). */
  readonly themeColors: Readonly<Record<string, string>>;
  /** Master `p:clrMap` attribute map (bg1 -> lt1, tx1 -> dk1, ...). */
  readonly colorMap: Readonly<Record<string, string>>;
  /** Optional slide/layout `p:overrideClrMapping` attribute map. */
  readonly colorMapOverride?: Readonly<Record<string, string>>;
}

export interface PptxResolvedColor {
  /** Six-digit uppercase hex with leading '#'. */
  readonly hex: string;
  /** 0..1 opacity after alpha modifiers. */
  readonly alpha: number;
}

export type PptxColorResolution =
  | { readonly ok: true; readonly color: PptxResolvedColor }
  | { readonly ok: false; readonly reason: string };

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const value = Number.parseInt(hex.replace(/^#/, ''), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
};

const rgbToHex = (r: number, g: number, b: number): string =>
  '#' +
  [r, g, b]
    .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

const rgbToHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
};

const hslToRgb = (h: number, s: number, l: number): { r: number; g: number; b: number } => {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const lum = clamp(l, 0, 1);
  if (sat === 0) {
    const value = Math.round(lum * 255);
    return { r: value, g: value, b: value };
  }
  const hueToRgb = (p: number, q: number, t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat;
  const p = 2 * lum - q;
  const hn = hue / 360;
  return {
    r: Math.round(hueToRgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hn) * 255),
    b: Math.round(hueToRgb(p, q, hn - 1 / 3) * 255),
  };
};

// PowerPoint blends tint/shade in linear RGB (IEC 61966-2-1), not gamma space.
const srgbToLinear = (channel: number): number => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (channel: number): number => {
  const s = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return clamp(Math.round(s * 255), 0, 255);
};

const applyTint = (hex: string, ratio: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(
    linearToSrgb(srgbToLinear(r) * ratio + (1 - ratio)),
    linearToSrgb(srgbToLinear(g) * ratio + (1 - ratio)),
    linearToSrgb(srgbToLinear(b) * ratio + (1 - ratio)),
  );
};

const applyShade = (hex: string, ratio: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(
    linearToSrgb(srgbToLinear(r) * ratio),
    linearToSrgb(srgbToLinear(g) * ratio),
    linearToSrgb(srgbToLinear(b) * ratio),
  );
};

const applyHsl = (
  hex: string,
  update: (hsl: { h: number; s: number; l: number }) => { h: number; s: number; l: number },
): string => {
  const { r, g, b } = hexToRgb(hex);
  const updated = update(rgbToHsl(r, g, b));
  const rgb = hslToRgb(updated.h, clamp(updated.s, 0, 1), clamp(updated.l, 0, 1));
  return rgbToHex(rgb.r, rgb.g, rgb.b);
};

/**
 * Apply OOXML color modifiers in document order. Unknown modifiers are a
 * resolution failure rather than a silent skip.
 */
export const applyPptxColorModifiers = (
  hex: string,
  modifiers: readonly PptxColorModifierIR[],
): PptxColorResolution => {
  const normalized = hex.replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    return { ok: false, reason: `Invalid sRGB color value ${hex}.` };
  }
  let color = `#${normalized}`;
  let alpha = 1;
  for (const modifier of modifiers) {
    const ratio = ooxmlPercentageToRatio(modifier.value);
    switch (modifier.kind) {
      case 'tint':
        color = applyTint(color, ratio);
        break;
      case 'shade':
        color = applyShade(color, ratio);
        break;
      case 'lumMod':
        color = applyHsl(color, ({ h, s, l }) => ({ h, s, l: l * ratio }));
        break;
      case 'lumOff':
        color = applyHsl(color, ({ h, s, l }) => ({ h, s, l: l + ratio }));
        break;
      case 'satMod':
        color = applyHsl(color, ({ h, s, l }) => ({ h, s: s * ratio, l }));
        break;
      case 'satOff':
        color = applyHsl(color, ({ h, s, l }) => ({ h, s: s + ratio, l }));
        break;
      case 'hueMod':
        color = applyHsl(color, ({ h, s, l }) => ({ h: h * ratio, s, l }));
        break;
      case 'hueOff':
        // hueOff val is an OOXML angle in 60000ths of a degree, so the raw
        // percentage ratio (1/100000) must be rescaled to degrees.
        color = applyHsl(color, ({ h, s, l }) => ({ h: h + (ratio * 100_000) / 60_000, s, l }));
        break;
      case 'alpha':
        alpha = clamp(ratio, 0, 1);
        break;
      case 'alphaOff':
        alpha = clamp(alpha + ratio, 0, 1);
        break;
      case 'alphaMod':
        alpha = clamp(alpha * ratio, 0, 1);
        break;
      default:
        return { ok: false, reason: `Unsupported color modifier ${modifier.kind}.` };
    }
  }
  return { ok: true, color: { hex: color, alpha } };
};

/** Map a scheme token through the override and master color maps. */
export const mapPptxSchemeToken = (token: string, context: PptxSchemeColorContext): string => {
  const override = context.colorMapOverride?.[token];
  if (override !== undefined) return override;
  return context.colorMap[token] ?? token;
};

export interface PptxColorResolutionOptions {
  /** Concrete color substituted for `phClr` tokens inside theme format styles. */
  readonly placeholderColor?: PptxResolvedColor;
}

/** Resolve a parsed color IR (srgb/scheme/system) to a concrete sRGB value. */
export const resolvePptxColor = (
  color: PptxColorIR,
  context: PptxSchemeColorContext,
  options: PptxColorResolutionOptions = {},
): PptxColorResolution => {
  switch (color.kind) {
    case 'srgb':
      return applyPptxColorModifiers(color.value, color.modifiers);
    case 'system':
      return applyPptxColorModifiers(color.fallbackValue, color.modifiers);
    case 'scheme': {
      if (color.token === 'phClr') {
        if (options.placeholderColor === undefined) {
          return { ok: false, reason: 'phClr requires a placeholder color from the style matrix.' };
        }
        const adjusted = applyPptxColorModifiers(options.placeholderColor.hex, color.modifiers);
        if (!adjusted.ok) return adjusted;
        return {
          ok: true,
          color: {
            hex: adjusted.color.hex,
            alpha: adjusted.color.alpha * options.placeholderColor.alpha,
          },
        };
      }
      const mapped = mapPptxSchemeToken(color.token, context);
      const themeValue = context.themeColors[mapped] ?? context.themeColors[color.token];
      if (themeValue === undefined) {
        return { ok: false, reason: `Scheme color ${color.token} has no theme value.` };
      }
      return applyPptxColorModifiers(themeValue, color.modifiers);
    }
  }
};

/** Build a scheme resolution context from a parsed theme style and clrMap attributes. */
export const createPptxSchemeColorContext = (
  theme: PptxThemeStyleIR | undefined,
  colorMap: Readonly<Record<string, string>>,
  colorMapOverride?: Readonly<Record<string, string>>,
): PptxSchemeColorContext => {
  const themeColors: Record<string, string> = {};
  for (const [token, color] of Object.entries(theme?.colorScheme?.colors ?? {})) {
    themeColors[token] = color.value;
  }
  return {
    themeColors,
    colorMap,
    ...(colorMapOverride === undefined ? {} : { colorMapOverride }),
  };
};
