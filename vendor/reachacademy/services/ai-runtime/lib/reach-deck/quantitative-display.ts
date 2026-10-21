/**
 * Slot-sized rendering rules shared by the host-rendered quantitative diagrams (function-plot and
 * chart). Production renders them at a fixed 16:9/4:3 source; once the compiled layout knows each
 * slot, they are re-rendered deterministically at slot size × device scale with text defined in
 * displayed slide px, so tick labels and axis titles stay readable after the layout shrinks them.
 */

import { CODE_MEDIA_LIMITS } from './code-media-policy.js';

/** Cache identity of slot-sized quantitative renders; bump whenever their pixels may change. */
export const QUANTITATIVE_DISPLAY_RENDERER_VERSION = 'quantitative-display/v1';

/**
 * Text sizes in displayed slide px. With measurable body text: tick labels, category labels and
 * data labels = tickRatio × body, axis/chart titles = body, both clamped to [floor, cap]. Without
 * body text, fallbackTick/fallbackTitle grow gently with the slot up to maxGrowth.
 */
export const QUANTITATIVE_DISPLAY_TYPOGRAPHY = Object.freeze({
  tickRatio: 0.85,
  floor: 18,
  tickCap: 28,
  titleCap: 32,
  fallbackTick: 18,
  fallbackTitle: 20,
  referenceSlot: 560,
  maxGrowth: 1.4,
});

/** Text sizes of one quantitative render, in the render's logical (displayed) px. */
export interface QuantitativeDisplayTypography {
  /** Axis tick labels, category labels, data labels and marker labels. */
  tick: number;
  /** Axis titles and chart titles. */
  title: number;
}

export function quantitativeDisplayTypography(
  display: { width: number; height: number },
  bodyFontSize?: number,
): QuantitativeDisplayTypography {
  const { tickRatio, floor, tickCap, titleCap, fallbackTick, fallbackTitle } =
    QUANTITATIVE_DISPLAY_TYPOGRAPHY;
  const clamp = (value: number, cap: number) => Math.min(cap, Math.max(floor, Math.round(value)));
  if (bodyFontSize !== undefined && Number.isFinite(bodyFontSize) && bodyFontSize > 0)
    return { tick: clamp(bodyFontSize * tickRatio, tickCap), title: clamp(bodyFontSize, titleCap) };
  const { referenceSlot, maxGrowth } = QUANTITATIVE_DISPLAY_TYPOGRAPHY;
  const growth = Math.min(
    maxGrowth,
    Math.max(1, Math.max(display.width, display.height) / referenceSlot),
  );
  return {
    tick: clamp(fallbackTick * growth, tickCap),
    title: clamp(fallbackTitle * growth, titleCap),
  };
}

/** Raster px per displayed slide px. */
export const QUANTITATIVE_DISPLAY_DEVICE_SCALE = 2;

interface RasterBounds {
  width: { minimum: number; maximum: number };
  height: { minimum: number; maximum: number };
  maximumPixels: number;
}

/**
 * Raster bounds of the function-plot renderer (REACH_FUNCTION_PLOT_RENDER_LIMITS; kept here so
 * the pipeline does not load the renderer's DOM/font stack — a test pins them equal).
 */
export const FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS: RasterBounds = Object.freeze({
  width: { minimum: 320, maximum: 1_920 },
  height: { minimum: 240, maximum: 1_080 },
  maximumPixels: 2_073_600,
});

/**
 * Raster bounds of an animated (tracer GIF) function plot: the renderer bounds narrowed to the
 * GIF sides and to the decoded-frame budget shared with code GIFs and the HTML layout validator.
 */
export function animatedFunctionPlotRasterBounds(frameCount: number): RasterBounds {
  return {
    width: {
      minimum: FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS.width.minimum,
      maximum: CODE_MEDIA_LIMITS.gifWidth,
    },
    height: {
      minimum: FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS.height.minimum,
      maximum: CODE_MEDIA_LIMITS.gifHeight,
    },
    maximumPixels: Math.min(
      FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS.maximumPixels,
      Math.floor(CODE_MEDIA_LIMITS.decodedFramePixels / frameCount),
    ),
  };
}

/** Production size of an animated plot: its static size scaled down into the GIF bounds. */
export function animatedFunctionPlotSize(
  base: { width: number; height: number },
  frameCount: number,
): { width: number; height: number } {
  const bounds = animatedFunctionPlotRasterBounds(frameCount);
  const scale = Math.min(
    1,
    bounds.width.maximum / base.width,
    bounds.height.maximum / base.height,
    Math.sqrt(bounds.maximumPixels / (base.width * base.height)),
  );
  return { width: Math.floor(base.width * scale), height: Math.floor(base.height * scale) };
}

/** Raster bounds of the static diagram renderer used for charts. */
export const CHART_DISPLAY_RASTER_BOUNDS: RasterBounds = Object.freeze({
  width: { minimum: 240, maximum: 2_048 },
  height: { minimum: 240, maximum: 2_048 },
  maximumPixels: 2_048 * 2_048,
});

/**
 * Raster size for a slot: display × device scale, lowered as needed to respect the renderer's
 * per-side and pixel-area bounds and raised (never above them) to the renderer's minimum sides.
 * Returns undefined when no raster within bounds keeps the slot aspect.
 */
export function quantitativeDisplayRasterSize(
  display: { width: number; height: number },
  bounds: RasterBounds,
): { width: number; height: number } | undefined {
  const { width, height } = display;
  if (!(width > 0 && height > 0)) return undefined;
  const upper = Math.min(
    bounds.width.maximum / width,
    bounds.height.maximum / height,
    Math.sqrt(bounds.maximumPixels / (width * height)),
  );
  const lower = Math.max(bounds.width.minimum / width, bounds.height.minimum / height);
  const scale = Math.min(upper, Math.max(QUANTITATIVE_DISPLAY_DEVICE_SCALE, lower));
  const raster = { width: Math.floor(width * scale), height: Math.floor(height * scale) };
  return raster.width >= bounds.width.minimum &&
    raster.height >= bounds.height.minimum &&
    raster.width <= bounds.width.maximum &&
    raster.height <= bounds.height.maximum &&
    raster.width * raster.height <= bounds.maximumPixels
    ? raster
    : undefined;
}

/** Approximate advance width of a label: CJK/full-width glyphs ≈ 1em, other glyphs ≈ 0.6em. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x115f)) em += 1;
    else if (/[.,:;'|!ilj ]/.test(char)) em += 0.32;
    else em += 0.6;
  }
  return em * fontSize;
}

/** d3-style nice ticks covering [min, max] with about `count` intervals. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(Number.isFinite(min) && Number.isFinite(max))) return [];
  if (min === max) return [min];
  const [low, high] = min < max ? [min, max] : [max, min];
  const raw = (high - low) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  const step = (error >= 7.07 ? 10 : error >= 3.16 ? 5 : error >= 1.41 ? 2 : 1) * power;
  const first = Math.ceil(low / step - 1e-9);
  const last = Math.floor(high / step + 1e-9);
  const ticks: number[] = [];
  for (let index = first; index <= last && ticks.length < 50; index++)
    ticks.push(roundTick(index * step, step));
  return ticks;
}

/** Nice ticks whose first and last values enclose [min, max]. */
export function niceDomainTicks(min: number, max: number, count: number): number[] {
  const inner = niceTicks(min, max, count);
  if (inner.length < 2) {
    const span = Math.abs(max - min) || Math.abs(max) || 1;
    return niceDomainTicks(Math.min(min, max) - span / 2, Math.max(min, max) + span / 2, count);
  }
  const step = inner[1]! - inner[0]!;
  const ticks = [...inner];
  if (ticks[0]! > min + 1e-9 * step) ticks.unshift(roundTick(ticks[0]! - step, step));
  if (ticks.at(-1)! < max - 1e-9 * step) ticks.push(roundTick(ticks.at(-1)! + step, step));
  return ticks;
}

function roundTick(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const rounded = Number(value.toFixed(Math.min(12, decimals)));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Plain decimal tick text: no exponent for ordinary teaching values, trailing zeros trimmed. */
export function formatTick(value: number): string {
  if (Object.is(value, -0) || value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e9 || abs < 1e-6) return String(Number(value.toPrecision(6)));
  return String(Number(value.toPrecision(12)));
}
