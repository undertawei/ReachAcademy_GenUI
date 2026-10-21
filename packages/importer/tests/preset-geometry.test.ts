import { describe, expect, it } from 'vitest';

import { createPptxGeometryGuides } from '../src/pptx/geometry/formula.js';
import {
  buildPptxPresetShapeGeometry,
  emitPptxGeometryPath,
  pptxPresetShapeDefinition,
} from '../src/pptx/geometry/preset-shapes.js';

const extent = { width: 100, height: 50 } as const;

const resolveIn = (formulas: Readonly<Record<string, string>>, token: string): number | undefined =>
  createPptxGeometryGuides(extent, new Map(Object.entries(formulas))).resolve(token);

describe('DrawingML geometry guides', () => {
  it('resolves the built-in shape guides against the element extent', () => {
    const resolve = (token: string) => resolveIn({}, token);

    expect(resolve('l')).toBe(0);
    expect(resolve('t')).toBe(0);
    expect(resolve('r')).toBe(100);
    expect(resolve('b')).toBe(50);
    expect(resolve('hc')).toBe(50);
    expect(resolve('vc')).toBe(25);
    expect(resolve('ss')).toBe(50);
    expect(resolve('ls')).toBe(100);
    expect(resolve('wd4')).toBe(25);
    expect(resolve('hd5')).toBe(10);
    expect(resolve('ssd8')).toBe(6.25);
    // Angles are 1/60000 degree: cd4 is a quarter turn.
    expect(resolve('cd4')).toBe(5_400_000);
    expect(resolve('3cd4')).toBe(16_200_000);
    expect(resolve('-42')).toBe(-42);
  });

  it('evaluates every formula operator the preset definitions use', () => {
    const cases: readonly (readonly [string, number])[] = [
      ['val 7', 7],
      ['abs -7', 7],
      ['sqrt 16', 4],
      ['*/ 10 3 2', 15],
      ['+- 10 3 2', 11],
      ['+/ 10 4 7', 2],
      ['?: 1 5 9', 5],
      ['?: -1 5 9', 9],
      ['?: 0 5 9', 9],
      ['max 3 9', 9],
      ['min 3 9', 3],
      ['mod 3 4 0', 5],
      ['pin 0 -5 10', 0],
      ['pin 0 5 10', 5],
      ['pin 0 50 10', 10],
      // 5400000 = 90°.
      ['sin 10 5400000', 10],
      ['cos 10 5400000', 0],
      ['tan 10 0', 0],
      ['at2 1 1', 2_700_000],
      ['cat2 10 1 0', 10],
      ['sat2 10 0 1', 10],
    ];

    for (const [formula, expected] of cases) {
      expect(resolveIn({ g: formula }, 'g'), formula).toBeCloseTo(expected, 6);
    }
  });

  it('refuses unknown operators, unknown references and cycles', () => {
    expect(resolveIn({ g: 'pow 2 3' }, 'g')).toBeUndefined();
    expect(resolveIn({ g: '*/ 1 missing 2' }, 'g')).toBeUndefined();
    expect(resolveIn({ g: 'val h2' }, 'g')).toBeUndefined();
    expect(resolveIn({ g: '+- g 1 0' }, 'g')).toBeUndefined();
    // A division by zero has no value rather than Infinity.
    expect(resolveIn({ g: '*/ 1 2 0' }, 'g')).toBeUndefined();
  });
});

describe('preset shape geometry', () => {
  it('covers every preset the OOXML standard defines', () => {
    expect(pptxPresetShapeDefinition('rect')).toBeDefined();
    expect(pptxPresetShapeDefinition('curvedUpArrow')).toBeDefined();
    expect(pptxPresetShapeDefinition('wedgeEllipseCallout')).toBeDefined();
    expect(pptxPresetShapeDefinition('notAPresetShape')).toBeUndefined();
  });

  it('emits arcs as SVG arc segments of at most a quarter turn', () => {
    const subpaths = buildPptxPresetShapeGeometry('ellipse', {}, { width: 100, height: 100 });

    // Two half-turn arcTo commands, each split into two quarter-turn segments.
    // Angles grow clockwise on screen, so 180°+90° is the top vertex.
    expect(subpaths).toEqual([
      {
        path: 'M 0 50 A 50 50 0 0 1 50 0 A 50 50 0 0 1 100 50 A 50 50 0 0 1 50 100 A 50 50 0 0 1 0 50 Z',
        fill: 'norm',
        stroked: true,
      },
    ]);
  });

  it('applies adjust values and the path coordinate space', () => {
    const [outline] = buildPptxPresetShapeGeometry('homePlate', { adj: 25000 }, extent) ?? [];

    // adj 25000 of the 50pt short side leaves the notch 12.5pt from the right.
    expect(outline?.path).toBe('M 0 0 L 87.5 0 L 100 25 L 87.5 50 L 0 50 Z');
  });

  it('scales a path that declares its own coordinate space', () => {
    const guides = createPptxGeometryGuides(extent, new Map());
    const path = emitPptxGeometryPath(
      { w: '10', h: '10', commands: [['M', '0', '0'], ['L', '10', '5'], ['Z']] },
      extent,
      guides,
    );

    expect(path).toBe('M 0 0 L 100 25 Z');
  });

  it('reports nothing for a preset outside the standard table', () => {
    expect(buildPptxPresetShapeGeometry('notAPresetShape', {}, extent)).toBeUndefined();
  });
});
