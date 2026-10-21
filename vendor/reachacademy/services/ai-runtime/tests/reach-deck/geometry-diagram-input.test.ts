import { describe, expect, it } from 'vitest';
import { parseGeometryEnvelopeV2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import {
  GEOMETRY_DIAGRAM_PROMPT,
  GEOMETRY_DIAGRAM_PROMPT_VERSION,
  GEOMETRY_DIAGRAM_SCHEMA,
  STATIC_GEOMETRY_EXAMPLES,
  buildStaticGeometryDiagram,
  selectStaticGeometryExamples,
  toModelGeometryOutput,
} from '../../lib/reach-deck/geometry-diagram-input.js';

const rightTriangle = () =>
  structuredClone(
    STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-right-triangle')!.output,
  ) as Record<string, unknown> & {
    objects: Record<string, unknown>[];
    measurements: Record<string, unknown>[];
    rightAngles: string[];
  };

describe('static geometry model input', () => {
  it('uses a strict object schema instead of string-encoded envelope JSON', () => {
    expect(GEOMETRY_DIAGRAM_PROMPT_VERSION).toBe('geometry-diagram/v4');
    const root = GEOMETRY_DIAGRAM_SCHEMA.schema as {
      properties: Record<string, { type?: string; items?: { anyOf?: unknown[] } }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(root.additionalProperties).toBe(false);
    expect(root.required.sort()).toEqual(Object.keys(root.properties).sort());
    expect(root.properties).not.toHaveProperty('envelopeJson');
    for (const key of ['objects', 'measurements', 'assertions']) {
      const variants = root.properties[key]!.items!.anyOf as {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      }[];
      expect(variants.length).toBeGreaterThan(1);
      for (const variant of variants) {
        // 以 kind 为唯一键，变体由第一个键决定，不受网关按字母序强制键顺序的影响。
        expect(variant.additionalProperties).toBe(false);
        expect(variant.required).toEqual(Object.keys(variant.properties));
        expect(variant.required).toHaveLength(1);
        const inner = variant.properties[variant.required[0]!] as {
          properties: Record<string, unknown>;
          required: string[];
          additionalProperties: boolean;
        };
        expect(inner.additionalProperties).toBe(false);
        expect(inner.required.sort()).toEqual(Object.keys(inner.properties).sort());
        expect(inner.properties).toHaveProperty('id');
        expect(inner.properties).not.toHaveProperty('kind');
      }
    }
    expect(GEOMETRY_DIAGRAM_PROMPT).toMatch(/guaranteed by construction/);
    expect(GEOMETRY_DIAGRAM_PROMPT).toMatch(/Vertex names/);
  });

  it('fills interactive-only boilerplate deterministically and passes the authoritative parser', () => {
    for (const example of STATIC_GEOMETRY_EXAMPLES) {
      const first = buildStaticGeometryDiagram(example.output);
      const second = buildStaticGeometryDiagram(structuredClone(example.output));
      expect(JSON.stringify(first.envelope)).toBe(JSON.stringify(second.envelope));
      expect(() => parseGeometryEnvelopeV2(first.envelope)).not.toThrow();
      expect(first.envelope.spec.interaction).toMatchObject({
        parameters: [],
        freedoms: [],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
      });
      expect(first.envelope.spec.interaction.exploration.limits).toEqual({
        objects: 0,
        measurements: 0,
        relations: 0,
      });
      expect(first.envelope.spec.relations).toEqual([]);
    }
    const diagram = buildStaticGeometryDiagram(rightTriangle());
    expect(diagram.envelope.spec.presentation.rightAngles).toEqual([
      { id: 'rightAngle1', measurement: 'angleC' },
    ]);
    expect(diagram.measurementDisplay).toMatchObject({ angleC: 'none', angleA: 'none' });
    expect(diagram.envelope.spec.presentation.objects).toContainEqual({
      object: 'AB',
      label: '斜边',
      colorToken: 'accent',
    });
    expect(diagram.envelope.spec.presentation.objects).toContainEqual({ object: 'C', label: 'C' });
  });

  it('accepts the kind-keyed model shape and converts examples to it', () => {
    for (const example of STATIC_GEOMETRY_EXAMPLES) {
      const keyed = toModelGeometryOutput(example.output) as Record<string, unknown[]>;
      for (const key of ['objects', 'measurements', 'assertions'])
        for (const entry of keyed[key]!) {
          expect(Object.keys(entry as object)).toHaveLength(1);
          expect(entry).not.toHaveProperty('kind');
        }
      expect(JSON.stringify(buildStaticGeometryDiagram(keyed).envelope)).toBe(
        JSON.stringify(buildStaticGeometryDiagram(example.output).envelope),
      );
    }
    const extra = toModelGeometryOutput(rightTriangle()) as { objects: Record<string, object>[] };
    extra.objects[1] = { point: { ...extra.objects[1]!.point, z: 1 } };
    expect(() => buildStaticGeometryDiagram(extra)).toThrow(/objects\[1\]\.z is not a field/);
  });

  it('defaults optional presentation fields and hides helper objects', () => {
    const input = {
      ariaLabel: 'Segment',
      units: 'cm',
      objects: [
        { id: 'A', kind: 'point', x: 0, y: 0 },
        { id: 'B', kind: 'point', x: 3, y: 0, hidden: true },
        { id: 'AB', kind: 'segment', a: 'A', b: 'B', label: '  ', lineStyle: 'dashed' },
      ],
      measurements: [{ id: 'len', kind: 'distance', a: 'A', b: 'B', label: 'AB' }],
      assertions: [],
      rightAngles: [],
    };
    const diagram = buildStaticGeometryDiagram(input);
    expect(diagram.envelope.spec.presentation.objects).toEqual([
      { object: 'A' },
      { object: 'B', visible: false },
      { object: 'AB', lineStyle: 'dashed' },
    ]);
    expect(diagram.envelope.spec.presentation.measurements).toEqual([
      { measurement: 'len', label: 'AB', decimals: 2 },
    ]);
    expect(diagram.measurementDisplay).toEqual({ len: 'labelAndValue' });
  });

  it('reports errors in the model input shape', () => {
    const unknownKind = rightTriangle();
    unknownKind.objects[0] = { id: 'E', kind: 'ellipse' };
    expect(() => buildStaticGeometryDiagram(unknownKind)).toThrow(
      /objects\[0\]\.kind ellipse is not supported/,
    );
    const extra = rightTriangle();
    extra.objects[1] = { ...extra.objects[1], z: 1 };
    expect(() => buildStaticGeometryDiagram(extra)).toThrow(/objects\[1\]\.z is not a field/);
    const lengthMark = rightTriangle();
    lengthMark.measurements.push({ id: 'd', kind: 'distance', a: 'A', b: 'B' });
    lengthMark.rightAngles = ['d'];
    expect(() => buildStaticGeometryDiagram(lengthMark)).toThrow(
      /rightAngles\[0\] must reference a threePointAngle or lineAngle/,
    );
    const dangling = rightTriangle();
    dangling.objects.splice(1, 0, { id: 'dangling', kind: 'segment', a: 'A', b: 'Z' });
    let message = '';
    try {
      buildStaticGeometryDiagram(dangling);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/unknown_reference: objects\[1\]/);
    expect(message).not.toContain('$.spec');
  });

  it('selects examples by relevance and prefers the right triangle for triangle briefs', () => {
    expect(selectStaticGeometryExamples('直角三角形 ABC，求 sin A')[0]!.id).toBe(
      'static-right-triangle',
    );
    expect(selectStaticGeometryExamples('三角形 ABC 中 AB 边上的高与垂足 H')[0]!.id).toBe(
      'static-altitude-foot',
    );
    expect(selectStaticGeometryExamples('量角器测量内角的度数')[0]!.id).toBe(
      'static-measured-angle',
    );
    expect(selectStaticGeometryExamples('')[0]!.id).toBe('static-right-triangle');
    expect(selectStaticGeometryExamples('anything')).toHaveLength(2);
  });
});
