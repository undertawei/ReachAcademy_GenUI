import { describe, expect, it } from 'vitest';

import { bindResolvedSlideScientificVisualAssets } from '../../lib/reach-deck/scientific-visual-generation.js';

const generated = {
  id: 'scientific-asset',
  documentHtml:
    '<div id="root"></div><script>ReachScientificVisual.register(() => ({present(){}}));</script>',
  manifest: {
    schemaVersion: 'reach-scientific-visual-manifest/v2' as const,
    hooksVersion: 'reach-scientific-visual-hooks/v1' as const,
    anchors: [{ id: 'apex', description: 'Projectile reaches its apex.' }],
    dependencies: [],
    resourceIds: [],
    ariaLabel: 'Projectile trajectory',
    textAlternative: 'A projectile rises and falls under gravity.',
  },
};

const binding = {
  manifest: {
    assetId: 'scientific-asset',
    kind: 'scientific-visual' as const,
    purpose: 'Explain projectile motion',
    alt: 'Projectile trajectory',
    aspectRatio: '16:9' as const,
    placement: 'primary' as const,
  },
  generated,
};

const slide = {
  id: 'page-1',
  elements: [
    {
      id: 'trajectory',
      type: 'scientificVisual',
      frame: { x: 100, y: 120, width: 1000, height: 600 },
      layer: 1,
      ariaLabel: null,
      assetId: 'scientific-asset',
    },
  ],
};

describe('scientific visual asset binding', () => {
  it('binds one layout-only reference to a complete durable payload', () => {
    const result = bindResolvedSlideScientificVisualAssets(slide, [binding]) as typeof slide & {
      elements: Array<Record<string, unknown>>;
    };
    expect(result.elements[0]).toMatchObject({
      id: 'trajectory',
      type: 'scientificVisual',
      ariaLabel: 'Projectile trajectory',
      documentHtml: generated.documentHtml,
      manifest: { schemaVersion: 'reach-scientific-visual-manifest/v2' },
      mediaResources: [],
    });
    expect(result.elements[0]).not.toHaveProperty('assetId');
  });

  it('requires exact-once use and rejects model-owned payload fields', () => {
    expect(() =>
      bindResolvedSlideScientificVisualAssets({ ...slide, elements: [] }, [binding]),
    ).toThrow(/exactly once/);
    expect(() =>
      bindResolvedSlideScientificVisualAssets(
        { ...slide, elements: [slide.elements[0], slide.elements[0]] },
        [binding],
      ),
    ).toThrow(/more than once/);
    expect(() =>
      bindResolvedSlideScientificVisualAssets(
        {
          ...slide,
          elements: [{ ...slide.elements[0], documentHtml: '<script>bad()</script>' }],
        },
        [binding],
      ),
    ).toThrow(/server-owned documentHtml/);
  });

  it('does not add a raster fallback resource', () => {
    const result = bindResolvedSlideScientificVisualAssets(slide, [binding]) as typeof slide & {
      elements: Array<Record<string, unknown>>;
    };
    expect(result.elements[0]).not.toHaveProperty('posterResourceId');
    expect(result.elements[0]).toMatchObject({ mediaResources: [] });
  });
});
