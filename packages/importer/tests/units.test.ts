import { describe, expect, it } from 'vitest';

import {
  emuToInches,
  emuToReachDeckStagePoints,
  emuToPoints,
  ooxmlAngleToDegrees,
  ooxmlPercentageToRatio,
  PptxGeometryError,
  pptxAngle,
  pptxEmu,
  pptxPercentage,
} from '../src/pptx/index.js';

describe('PPTX source-preserving units', () => {
  it('retains exact OOXML tokens while converting standard units', () => {
    expect(pptxEmu('+0914400')).toEqual({ unit: 'emu', raw: '+0914400' });
    expect(emuToInches(pptxEmu('914400'))).toBe(1);
    expect(emuToPoints(pptxEmu('12700'))).toBe(1);
    expect(ooxmlAngleToDegrees(pptxAngle('5400000'))).toBe(90);
    expect(ooxmlPercentageToRatio(pptxPercentage('25000'))).toBe(0.25);
  });

  it('normalizes near-whole-point stage dimensions from rounded producer units', () => {
    expect(emuToReachDeckStagePoints(pptxEmu('12191695'))).toBe(960);
    expect(emuToReachDeckStagePoints(pptxEmu('6858000'))).toBe(540);
    expect(emuToReachDeckStagePoints(pptxEmu('12190000'))).toBeUndefined();
  });

  it('rejects invalid or lossy source numbers instead of applying defaults', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.25]) {
      expect(() => pptxEmu(value)).toThrow(PptxGeometryError);
    }
    expect(() => pptxAngle('1.5')).toThrow(/integer/i);
    expect(() => emuToPoints(pptxEmu('9007199254740992'))).toThrow(/without losing precision/i);
  });
});
