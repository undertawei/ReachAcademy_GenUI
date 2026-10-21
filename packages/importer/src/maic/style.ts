import type { ReachDeckColorV2, ReachDeckFillV2 } from '@reachany/reach-deck-dsl';

const parseMaicColor = (input: unknown): ReachDeckColorV2 | undefined => {
  const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (raw === 'transparent') return { kind: 'srgb', value: '#000000', alpha: 0 };
  const hex = /^#([a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(raw);
  if (hex) {
    const value = hex[1]!;
    const expanded = value.length < 5 ? [...value].map((part) => part + part).join('') : value;
    return {
      kind: 'srgb',
      value: `#${expanded.slice(0, 6).toUpperCase()}`,
      ...(expanded.length === 8 ? { alpha: Number.parseInt(expanded.slice(6), 16) / 255 } : {}),
    };
  }
  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/.exec(
      raw,
    );
  if (
    rgb &&
    rgb.slice(1, 4).every((part) => Number(part) <= 255) &&
    (rgb[4] === undefined || Number(rgb[4]) <= 1)
  ) {
    return {
      kind: 'srgb',
      value: `#${rgb
        .slice(1, 4)
        .map((part) => Math.round(Number(part)).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`,
      ...(rgb[4] === undefined ? {} : { alpha: Number(rgb[4]) }),
    };
  }
  return undefined;
};

export const maicColor = (input: unknown, fallback = '#000000'): ReachDeckColorV2 =>
  parseMaicColor(input) ?? { kind: 'srgb', value: fallback };

export const maicCssColor = (input: unknown): string | undefined => {
  const value = parseMaicColor(input);
  if (value?.kind !== 'srgb') return undefined;
  return (
    value.value +
    (value.alpha === undefined
      ? ''
      : Math.round(value.alpha * 255)
          .toString(16)
          .padStart(2, '0')
          .toUpperCase())
  );
};

export const maicSolidFill = (input: unknown): ReachDeckFillV2 =>
  input === '' || input === undefined || input === 'transparent'
    ? { kind: 'none' }
    : { kind: 'solid', color: maicColor(input) };

export const maicLinearGradient = (
  input: string,
): { angle: number; stops: Array<{ offset: number; color: string }> } | undefined => {
  const match = /^linear-gradient\(\s*(?:(-?\d+(?:\.\d+)?)deg\s*,\s*)?(.*)\)(?:\s+text)?$/i.exec(
    input.trim(),
  );
  if (!match) return undefined;
  const parts = match[2]!.split(/,(?![^()]*\))/);
  const stops = parts.map((part) => {
    const stop = /^(.*?)\s+(\d+(?:\.\d+)?)%\s*$/.exec(part.trim());
    const color = stop && maicCssColor(stop[1]);
    const offset = stop ? Number(stop[2]) / 100 : NaN;
    return color && offset >= 0 && offset <= 1 ? { offset, color } : undefined;
  });
  const angle = match[1] === undefined ? 180 : Number(match[1]);
  return Number.isFinite(angle) &&
    stops.length >= 2 &&
    stops.length <= 32 &&
    stops.every((stop) => stop !== undefined)
    ? { angle, stops: stops as Array<{ offset: number; color: string }> }
    : undefined;
};
