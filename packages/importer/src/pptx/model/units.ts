/**
 * Unit conversion formulas adapted from OpenMAIC's PPTX importer
 * (`parser/units.ts`) at commit 63fc81d8e1e8e13d04106618ef29f713541a520e.
 * OpenMAIC is distributed under the MIT license; see THIRD_PARTY_NOTICES.md.
 */

export type PptxGeometryErrorCode =
  | 'pptx.geometry.invalid_source_integer'
  | 'pptx.geometry.invalid_boolean'
  | 'pptx.geometry.unsafe_numeric_conversion'
  | 'pptx.geometry.non_finite_value'
  | 'pptx.geometry.invalid_extent'
  | 'pptx.geometry.singular_transform';

export class PptxGeometryError extends Error {
  constructor(
    readonly code: PptxGeometryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PptxGeometryError';
  }
}

export interface PptxEmu {
  readonly unit: 'emu';
  /** The exact OOXML integer token, retained without numeric normalization. */
  readonly raw: string;
}

export interface PptxAngle {
  readonly unit: 'ooxml-angle';
  /** The exact OOXML integer token in 60,000ths of a degree. */
  readonly raw: string;
}

export interface PptxPercentage {
  readonly unit: 'ooxml-percentage';
  /** The exact OOXML integer token where 100,000 represents 100%. */
  readonly raw: string;
}

export type PptxIntegerSource = string | number;

const sourceInteger = <Unit extends PptxEmu['unit'] | PptxAngle['unit'] | PptxPercentage['unit']>(
  unit: Unit,
  input: PptxIntegerSource,
  label: string,
): Readonly<{ unit: Unit; raw: string }> => {
  const raw = typeof input === 'number' ? String(input) : input;
  if (
    (typeof input === 'number' && (!Number.isFinite(input) || !Number.isSafeInteger(input))) ||
    !/^[+-]?\d+$/.test(raw)
  ) {
    throw new PptxGeometryError(
      'pptx.geometry.invalid_source_integer',
      `${label} must be an OOXML integer token or a safe integer.`,
    );
  }
  return Object.freeze({ unit, raw });
};

export const pptxEmu = (input: PptxIntegerSource): PptxEmu =>
  sourceInteger('emu', input, 'EMU value');

export const pptxAngle = (input: PptxIntegerSource): PptxAngle =>
  sourceInteger('ooxml-angle', input, 'Angle value');

export const pptxPercentage = (input: PptxIntegerSource): PptxPercentage =>
  sourceInteger('ooxml-percentage', input, 'Percentage value');

const sourceIntegerToSafeNumber = (
  value: PptxEmu | PptxAngle | PptxPercentage,
  label: string,
): number => {
  let integer: bigint;
  try {
    integer = BigInt(value.raw);
  } catch {
    throw new PptxGeometryError(
      'pptx.geometry.invalid_source_integer',
      `${label} is not an OOXML integer token.`,
    );
  }
  if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PptxGeometryError(
      'pptx.geometry.unsafe_numeric_conversion',
      `${label} cannot be converted to a deterministic JavaScript number without losing precision.`,
    );
  }
  return Number(integer);
};

export const emuToInches = (value: PptxEmu): number =>
  sourceIntegerToSafeNumber(value, 'EMU value') / 914_400;

export const emuToPoints = (value: PptxEmu): number =>
  sourceIntegerToSafeNumber(value, 'EMU value') / 12_700;

/**
 * Reach Deck stages use whole points, while real-world PPTX producers often
 * serialize a nominal point size through a rounded inch/centimeter conversion.
 * Accept only a small, explicit quantization error so a 16:9 stage such as
 * 12191695 EMU (959.976 pt) can map to 960 pt without silently accepting a
 * materially different custom canvas.
 */
export const PPTX_REACH_DECK_STAGE_POINT_TOLERANCE = 0.05;

export const emuToReachDeckStagePoints = (value: PptxEmu): number | undefined => {
  const points = emuToPoints(value);
  const rounded = Math.round(points);
  return rounded > 0 && Math.abs(points - rounded) <= PPTX_REACH_DECK_STAGE_POINT_TOLERANCE
    ? rounded
    : undefined;
};

export const ooxmlAngleToDegrees = (value: PptxAngle): number =>
  sourceIntegerToSafeNumber(value, 'Angle value') / 60_000;

export const ooxmlPercentageToRatio = (value: PptxPercentage): number =>
  sourceIntegerToSafeNumber(value, 'Percentage value') / 100_000;

export const assertFiniteGeometryNumber = (value: number, label: string): number => {
  if (!Number.isFinite(value)) {
    throw new PptxGeometryError(
      'pptx.geometry.non_finite_value',
      `${label} must be a finite number.`,
    );
  }
  return Object.is(value, -0) ? 0 : value;
};
