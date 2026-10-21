import { describe, expect, it } from 'vitest';
import { parseReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { evaluateGeometry } from '@reachany/reach-deck-geometry';
import {
  createGeometryPlayerHarnessFixture,
  geometryPlayerEnvelope,
} from '../../scripts/reach-deck/geometry-player-fixtures.js';

describe('production Player geometry fixtures', () => {
  it('builds a deterministic reader document with bounded geometry-only interactive pages', () => {
    const fixture = createGeometryPlayerHarnessFixture();
    expect(fixture.document).toEqual(createGeometryPlayerHarnessFixture().document);
    expect(parseReachDeckDocumentV2(fixture.document)).toEqual(fixture.document);
    expect(fixture.document.pages).toHaveLength(13);
    expect(fixture.assetsByResourceId.size).toBe(0);
    expect(fixture.document.nativeSlides).toEqual([]);
    for (const page of fixture.document.pages) {
      expect(page.sceneType).toBe('interactive');
      if (page.sceneType !== 'interactive') throw new Error('Expected interactive page');
      expect(page.scene.runtimePolicy.completionMode).toBe('none');
      expect(page.scene.documentHtml).toContain('data-reach-science-kit');
      expect(page.scene.documentHtml).toContain('restoreToken');
      expect(page.scene.documentHtml).not.toContain('ReachInteractive.complete');
      expect(
        page.scene.runtimeDependencies?.every(
          (runtime) =>
            runtime.id === 'geometry-euclidean-2d' || runtime.id === 'geometry-euclidean-3d',
        ),
      ).toBe(true);
    }
  });

  it.each([30, 90, 120, 180])(
    'keeps the analytical dihedral %i degrees behind the rendered fixture',
    (angle) => {
      const result = evaluateGeometry(geometryPlayerEnvelope(`G4-half-planes-${angle}`));
      expect(result.snapshot.measurements.angleValue?.value).toBeCloseTo(angle, 8);
    },
  );
});
