import { describe, expect, it } from 'vitest';

import {
  INTERACTIVE_SCIENCE_KIT_DEFINITIONS,
  interactiveScienceKitRuntimeDependency,
  parseInteractiveScienceKitEnvelopeValue,
  type InteractiveScienceKitId,
} from '../src/interactiveScienceKit.js';

const specs: Record<InteractiveScienceKitId, Record<string, unknown>> = {
  'geometry-board': {
    schemaVersion: 'reach-geometry-board/v1',
    ariaLabel: 'Geometry',
    viewport: { x: [-5, 5], y: [-5, 5], grid: true },
    points: [
      { id: 'A', x: 0, y: 0, draggable: true },
      { id: 'B', x: 1, y: 1, draggable: false },
    ],
    shapes: [],
    measurements: [],
  },
  'mechanics-2d': {
    schemaVersion: 'reach-mechanics-2d/v1',
    ariaLabel: 'Mechanics',
    world: { width: 800, height: 480, gravity: { x: 0, y: 1 }, fixedStepHz: 60 },
    bodies: [
      {
        id: 'ball',
        shape: 'circle',
        radius: 20,
        position: { x: 200, y: 80 },
        angle: 0,
        velocity: { x: 0, y: 0 },
        angularVelocity: 0,
        isStatic: false,
        mass: 1,
        friction: 0.1,
        restitution: 0.5,
        colorToken: 'accent',
      },
    ],
    constraints: [],
    parameters: [],
  },
  'molecule-2d': {
    schemaVersion: 'reach-molecule-2d/v1',
    ariaLabel: 'Molecule',
    layout: 'single',
    molecules: [{ id: 'water', smiles: 'O', highlights: [] }],
    selectionMode: 'none',
  },
  'bio-network': {
    schemaVersion: 'reach-bio-network/v1',
    ariaLabel: 'Network',
    layout: 'circle',
    nodes: [{ id: 'plant' }],
    edges: [],
    interaction: { selectable: true, draggable: true, zoomable: true },
  },
  'geo-map': {
    schemaVersion: 'reach-geo-map/v1',
    ariaLabel: 'Map',
    baseMapId: 'world-110m-v1',
    projection: { kind: 'equal-earth', center: [0, 0], rotate: [0, 0, 0] },
    layers: [],
    interaction: { pan: false, zoom: false, rotate: false },
  },
  'solid-3d': {
    schemaVersion: 'reach-solid-3d/v1',
    ariaLabel: 'Solid',
    camera: { preset: 'isometric', target: [0, 0, 0] },
    solids: [
      {
        id: 'cube',
        kind: 'box',
        dimensions: [2, 2, 2],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        colorToken: 'accent',
        opacity: 1,
      },
    ],
    measurements: [],
    interaction: { orbit: true, zoom: true, selectable: false },
  },
  'molecule-3d': {
    schemaVersion: 'reach-molecule-3d/v1',
    ariaLabel: 'Molecule 3D',
    structures: [{ id: 'model', format: 'pdb', data: 'ATOM' }],
    representations: [
      { id: 'sticks', structureId: 'model', style: 'stick', colorScheme: 'element' },
    ],
    selections: [],
    interaction: { orbit: true, zoom: true, selectableAtoms: false },
  },
  'sequence-track': {
    schemaVersion: 'reach-sequence-track/v1',
    ariaLabel: 'Sequence',
    alphabet: 'dna',
    sequence: 'ACGT',
    tracks: [{ id: 'sites', features: [] }],
    interaction: { zoom: true, pan: true, selectable: true },
  },
  'dynamic-geometry': {
    schemaVersion: 'reach-dynamic-geometry/v1',
    ariaLabel: 'Construction',
    board: { boundingBox: [-5, 5, 5, -5], axes: true, grid: true, snapSize: 1 },
    points: [
      { id: 'A', x: -2, y: 0, mobility: 'free' },
      { id: 'B', x: 2, y: 0, mobility: 'free' },
    ],
    constructions: [
      { id: 'AB', kind: 'segment', from: 'A', to: 'B', colorToken: 'ink' },
      { id: 'M', kind: 'midpoint', a: 'A', b: 'B', colorToken: 'accent' },
    ],
    measurements: [],
  },
};

describe('Interactive science kit contract', () => {
  it('accepts every pinned kit and resolves its facade runtime', () => {
    for (const kitId of Object.keys(
      INTERACTIVE_SCIENCE_KIT_DEFINITIONS,
    ) as InteractiveScienceKitId[]) {
      const parsed = parseInteractiveScienceKitEnvelopeValue({
        schemaVersion: 'reach-science-kit/v1',
        kitId,
        kitVersion: 1,
        spec: specs[kitId],
      });
      expect(parsed.kitId).toBe(kitId);
      expect(interactiveScienceKitRuntimeDependency(kitId)).toEqual({
        id: INTERACTIVE_SCIENCE_KIT_DEFINITIONS[kitId].runtimeId,
        version: '1.0.0',
      });
    }
  });

  it('rejects unknown kits, extra fields, invalid alphabets, and oversized markers', () => {
    expect(() =>
      parseInteractiveScienceKitEnvelopeValue({
        schemaVersion: 'reach-science-kit/v1',
        kitId: 'unknown',
        kitVersion: 1,
        spec: {},
      }),
    ).toThrow(/id or version/);
    expect(() =>
      parseInteractiveScienceKitEnvelopeValue({
        schemaVersion: 'reach-science-kit/v1',
        kitId: 'geo-map',
        kitVersion: 1,
        spec: { ...specs['geo-map'], url: 'https://example.test' },
      }),
    ).toThrow(/fields/);
    expect(() =>
      parseInteractiveScienceKitEnvelopeValue({
        schemaVersion: 'reach-science-kit/v1',
        kitId: 'sequence-track',
        kitVersion: 1,
        spec: { ...specs['sequence-track'], sequence: 'ACXT' },
      }),
    ).toThrow(/alphabet/);
    expect(() =>
      parseInteractiveScienceKitEnvelopeValue({
        schemaVersion: 'reach-science-kit/v1',
        kitId: 'molecule-3d',
        kitVersion: 1,
        spec: {
          ...specs['molecule-3d'],
          structures: [{ id: 'model', format: 'pdb', data: 'A'.repeat(70_000) }],
        },
      }),
    ).toThrow(/size limit/);
    expect(() =>
      parseInteractiveScienceKitEnvelopeValue({
        schemaVersion: 'reach-science-kit/v1',
        kitId: 'solid-3d',
        kitVersion: 1,
        spec: {
          ...specs['solid-3d'],
          solids: [
            {
              ...(specs['solid-3d'].solids as Record<string, unknown>[])[0],
              kind: 'invalid',
              type: 'box',
            },
          ],
        },
      }),
    ).toThrow(/solid kind/);
  });
});
