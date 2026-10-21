import scenarios from '../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeometrySession } from '@reachany/reach-deck-geometry/session';
import type { GeometryEnvelope } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { createSpatialView, placeGeometryLabels } from '../scripts/geometry-spatial';

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
const fixtures = scenarios as unknown as { id: string; envelope: GeometryEnvelope }[];
function envelope(): GeometryEnvelope {
  const source = structuredClone(fixtures.find((item) => item.id === 'G3-pyramid')!.envelope);
  return {
    ...source,
    spec: {
      ...source.spec,
      presentation: {
        ...source.spec.presentation,
        objects: source.spec.objects.map((object) => ({ object: object.id, label: object.id })),
        measurements: source.spec.measurements.map((measurement) => ({
          measurement: measurement.id,
        })),
        groups: [{ id: 'pyramid', objects: ['P', 'M'], measurements: [] }],
      },
      interaction: { ...source.spec.interaction, visibleGroups: ['pyramid'] },
    },
  };
}

describe('spatial DTO rendering and projection', () => {
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
  it.each([
    [1440, 900],
    [1024, 768],
    [390, 844],
    [844, 390],
  ])('places coincident and edge labels without overlap at %ix%i', (width, height) => {
    const sceneHeight = Math.round(height * 0.55);
    const labels = Array.from({ length: 16 }, (_, index) => ({
      id: `label${index}`,
      anchor: [width * 0.52 + (index % 3), sceneHeight - 6] as const,
      width: index % 4 === 0 ? 80 : 24,
      height: 18,
    }));
    const placed = placeGeometryLabels(labels, width, sceneHeight);
    expect(placed).toHaveLength(labels.length);
    expect(placeGeometryLabels(labels, width, sceneHeight)).toEqual(placed);
    placed.forEach((box, index) => {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(sceneHeight);
      for (const other of placed.slice(index + 1))
        expect(
          box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y,
        ).toBe(false);
    });
  });
  it('keeps wrapped labels fully within a compact scene', () => {
    const labels = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      anchor: [190, 195] as const,
      width: 120,
      height: 36,
    }));
    const placed = placeGeometryLabels(labels, 390, 200);
    expect(placed).toHaveLength(5);
    placed.forEach((box) => {
      expect(box.y + box.height).toBeLessThanOrEqual(200);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    });
  });
  it('renders/picks declared points from snapshots and respects hidden groups', () => {
    const source = envelope(),
      session = createGeometrySession(source, 'spatial'),
      container = document.querySelector<HTMLElement>('#scene')!;
    const view = createSpatialView(container, source, vi.fn());
    try {
      view.resize(800, 500);
      view.paint(session.getComputedState());
      const p = session.getComputedState().objects.P.coordinates!,
        screen = view.project(p)!;
      expect(view.pick(screen, 'mouse')).toMatchObject({
        objectId: 'P',
        freedomId: 'dragP',
        selectable: true,
      });
      expect(container.querySelector('[data-geometry-label="P"]')!.textContent).toBe('P');
      session.applyCommand({
        schemaVersion: 'reach-geometry-command/v1',
        kind: 'setGroup',
        id: 'pyramid',
        visible: false,
      });
      view.paint(session.getComputedState());
      expect(container.querySelector('[data-geometry-label="P"]')).toBeNull();
      expect(view.pick(screen, 'touch')?.objectId).not.toBe('P');
      expect(rendererCalls.render).toHaveBeenCalledTimes(2);
    } finally {
      view.dispose();
      session.dispose();
    }
  });
  it('proposes the same affine line input under different camera projections', () => {
    const source = envelope(),
      session = createGeometrySession(source, 'projection'),
      view = createSpatialView(document.querySelector<HTMLElement>('#scene')!, source, vi.fn());
    try {
      view.resize(800, 500);
      for (const projection of ['orthographic', 'perspective'] as const) {
        const camera = session.getComputedState().camera;
        if (camera.kind !== 'spatial') throw new Error('spatial');
        session.applyCommand({
          schemaVersion: 'reach-geometry-command/v1',
          kind: 'setCamera',
          camera: { ...camera, projection },
        });
        const state = session.getComputedState();
        view.paint(state);
        const point = state.objects.P.coordinates!,
          pixel = view.project(point)!;
        const freedom = source.spec.interaction.freedoms.find((item) => item.id === 'dragP')!;
        const proposed = view.dragPoint(pixel, freedom, state)!;
        expect(proposed).toHaveLength(3);
        point.forEach((value, i) => expect(proposed[i]).toBeCloseTo(value, 7));
      }
    } finally {
      view.dispose();
      session.dispose();
    }
  });
  it('routes WebGL context loss and disposes renderer/scene resources idempotently', () => {
    const source = envelope(),
      session = createGeometrySession(source, 'lifecycle'),
      container = document.querySelector<HTMLElement>('#scene')!,
      failed = vi.fn();
    const view = createSpatialView(container, source, failed);
    view.resize(800, 500);
    view.paint(session.getComputedState());
    const event = new dom.window.Event('webglcontextlost', { cancelable: true });
    container.querySelector('canvas')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(failed).toHaveBeenCalledOnce();
    view.dispose();
    view.dispose();
    session.dispose();
    expect(rendererCalls.dispose).toHaveBeenCalledOnce();
    expect(rendererCalls.lose).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
  });
});
