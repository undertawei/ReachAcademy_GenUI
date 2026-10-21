import scenarios from '../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeometryEnvelope } from '@reachany/reach-deck-dsl/euclidean-geometry';
import type {
  GeometryAuxiliaryStateV2,
  GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { createGeometrySessionV2 } from '@reachany/reach-deck-geometry/session-v2';
import { createSpatialViewV2 } from '../scripts/geometry-spatial-v2';

const rendererCalls = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), lose: vi.fn() }));
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      setPixelRatio() {}
      setClearColor() {}
      setSize() {}
      render(scene: import('three').Scene) {
        scene.updateMatrixWorld(true);
        rendererCalls.render();
      }
      dispose() {
        rendererCalls.dispose();
      }
      forceContextLoss() {
        rendererCalls.lose();
      }
    },
  };
});

const source = structuredClone(
  (scenarios as unknown as { id: string; envelope: GeometryEnvelope }[]).find(
    (item) => item.id === 'G3-pyramid',
  )!.envelope,
);
const envelope: GeometryEnvelopeV2 = {
  ...source,
  kitVersion: 2,
  spec: {
    ...source.spec,
    schemaVersion: 'reach-euclidean-geometry/v2',
    relations: [],
    presentation: {
      ...source.spec.presentation,
      objects: source.spec.objects.map((object) => ({ object: object.id, label: object.id })),
      relations: [],
    },
    interaction: {
      ...source.spec.interaction,
      exploration: {
        objectKinds: ['pointOnLine'],
        measurementKinds: [],
        relationKinds: [],
        referenceableObjects: source.spec.objects.map((object) => object.id),
        limits: { objects: 4, measurements: 0, relations: 0 },
        feedback: 'immediate',
      },
    },
  },
};
const auxiliary: GeometryAuxiliaryStateV2 = {
  objects: [{ id: 'L_Q', kind: 'pointOnLine', line: 'BC', t: 0.5 }],
  measurements: [],
  relations: [],
  freedoms: [
    {
      id: 'L_dragQ',
      kind: 'line',
      object: 'L_Q',
      range: { min: 0, max: 1, step: 0.05 },
    },
  ],
  presentation: {
    objects: [{ object: 'L_Q', label: 'Q helper', colorToken: 'accent' }],
    measurements: [],
    relations: [],
  },
};

describe('geometry v2 spatial composition', () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="scene"></div>', { pretendToBeVisual: true });
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('window', dom.window);
    Object.values(rendererCalls).forEach((mock) => mock.mockClear());
  });
  afterEach(() => {
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('rebuilds Three.js with auxiliary presentation, pick, freedom, and hidden state', () => {
    const session = createGeometrySessionV2(envelope, 'spatial-v2');
    const view = createSpatialViewV2(
      document.querySelector<HTMLElement>('#scene')!,
      envelope,
      vi.fn(),
    );
    try {
      expect(
        session.applyCommand({
          schemaVersion: 'reach-geometry-command/v2',
          kind: 'addAuxiliary',
          auxiliary,
        }).ok,
      ).toBe(true);
      view.resize(800, 500);
      view.rebuild(session.getComputedState());
      const point = session.getComputedState().objects.L_Q.coordinates!;
      const pixel = view.project(point)!;
      expect(view.pickCandidates(pixel, 'touch')).toContain('L_Q');
      expect(document.querySelector('[data-geometry-label="L_Q"]')?.textContent).toBe('Q helper');
      expect(
        view.dragPoint(pixel, auxiliary.freedoms[0]!, session.getComputedState()),
      ).toHaveLength(3);

      expect(
        session.applyCommand({
          schemaVersion: 'reach-geometry-command/v2',
          kind: 'setAuxiliaryHidden',
          id: 'L_Q',
          hidden: true,
        }).ok,
      ).toBe(true);
      view.paint(session.getComputedState());
      expect(document.querySelector('[data-geometry-label="L_Q"]')).toBeNull();
      expect(view.pickCandidates(pixel, 'touch')).not.toContain('L_Q');
      expect(rendererCalls.dispose).toHaveBeenCalledOnce();
    } finally {
      view.dispose();
      session.dispose();
    }
  });
});
