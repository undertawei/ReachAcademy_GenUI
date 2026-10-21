import { describe, expect, it } from 'vitest';
import { INTERACTIVE_RUNTIME_PINS } from '@reachany/reach-deck-dsl';

import { buildReachDeckScientificToolCatalog } from '../../lib/reach-deck/scientific-tool-catalog.js';

describe('Reach Deck scientific tool catalog', () => {
  it('describes the pinned Cartesian engine and the interactive custom runtime', () => {
    const catalog = buildReachDeckScientificToolCatalog({
      contexts: ['slide-asset', 'interactive'],
      scientificVisualsEnabled: false,
    });

    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'cartesian-plot',
          contract: 'reach-function-plot/v2',
          engine: { id: 'function-plot', version: '1.25.4' },
          runtimeDependency: { id: 'function-plot', version: '1.25.4' },
          contexts: ['slide-asset', 'interactive'],
          license: 'MIT',
        }),
        expect.objectContaining({
          capability: 'custom-interactive-document',
          engine: { id: 'reach-interactive-bridge', version: 'v1' },
          contexts: ['interactive'],
        }),
        expect.objectContaining({
          capability: 'euclidean-geometry-2d',
          contract: 'reach-euclidean-geometry/v2',
          runtimeDependency: { id: 'geometry-euclidean-2d-v2', version: '1.0.0' },
          contexts: ['interactive'],
        }),
        expect.objectContaining({
          capability: 'euclidean-geometry-3d',
          contract: 'reach-euclidean-geometry/v2',
          runtimeDependency: { id: 'geometry-euclidean-3d-v2', version: '1.0.0' },
          contexts: ['interactive'],
        }),
      ]),
    );
    const geometry = catalog.find((entry) => entry.capability === 'euclidean-geometry-2d')!;
    expect(geometry.supports).toContain(
      'policy-bounded learner auxiliary constructions, measurements, and relation queries',
    );
    expect(geometry.limits).toMatchObject({
      learnerConstruction: 'policy-bounded auxiliary graph only',
      maximumAuxiliaryObjects: 32,
      maximumAuxiliaryMeasurements: 8,
      maximumAuxiliaryRelations: 8,
      learnerIdPrefix: 'L_',
    });
    expect(catalog).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: 'custom-scientific-visual' })]),
    );
    for (const entry of catalog) {
      if (entry.runtimeDependency === undefined) continue;
      expect(entry.runtimeDependency.version).toBe(
        INTERACTIVE_RUNTIME_PINS[
          entry.runtimeDependency.id as keyof typeof INTERACTIVE_RUNTIME_PINS
        ],
      );
    }
  });

  it('exposes the custom scientific runtime only when its producer is enabled', () => {
    expect(
      buildReachDeckScientificToolCatalog({
        contexts: ['scientific-visual'],
        scientificVisualsEnabled: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'custom-scientific-visual',
          engine: { id: 'reach-scientific-visual-hooks', version: 'v1' },
          contexts: ['scientific-visual'],
        }),
      ]),
    );
  });
});
