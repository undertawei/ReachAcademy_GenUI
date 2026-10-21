import scenarios from '../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GeometryEnvelope,
  GeometryFreedom,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import { createGeometrySession } from '@reachany/reach-deck-geometry/session';
import { GEOMETRY_MESSAGE_DEFAULTS } from '../src/geometryMessages.js';
import { mountGeometry, type GeometryScienceKitController } from '../scripts/geometry-runtime';
import {
  proposeFreedom,
  zoomGeometryCamera,
  type GeometryView,
} from '../scripts/geometry-interaction';
import { orbitGeometryCamera } from '../scripts/geometry-spatial';

const fixtures = scenarios as unknown as { id: string; envelope: GeometryEnvelope }[];
const fixture = (id: string) => structuredClone(fixtures.find((item) => item.id === id)!.envelope);
const version = 'reach-geometry-command/v1';

describe('declared input proposals', () => {
  it('projects free point and line/circle freedoms without changing the engine', () => {
    const envelope = fixture('G1-planar-dependencies'),
      session = createGeometrySession(envelope, 'projection');
    try {
      const before = session.getComputedState();
      const point = envelope.spec.interaction.freedoms.find((item) => item.kind === 'freePoint')!;
      expect(proposeFreedom(envelope.spec, point, before, [1000, -1000])).toEqual({
        x: (point as Extract<GeometryFreedom, { kind: 'freePoint' }>).x.max,
        y: (point as Extract<GeometryFreedom, { kind: 'freePoint' }>).y.min,
      });
      const circle = envelope.spec.interaction.freedoms.find((item) => item.kind === 'circle')!;
      const center = before.objects.A.coordinates!;
      expect(proposeFreedom(envelope.spec, circle, before, [center[0], center[1] + 2])).toBeCloseTo(
        Math.PI / 2,
      );
      expect(proposeFreedom(envelope.spec, circle, before, center)).toBeNull();
      expect(session.getComputedState()).toEqual(before);
    } finally {
      session.dispose();
    }
  });
  it('projects an oblique plane into the declared ordered frame', () => {
    const source = fixture('G3-pyramid');
    const envelope = {
      ...source,
      spec: {
        ...source.spec,
        objects: [
          { id: 'O', kind: 'point' as const, x: 1, y: 2, z: 3 },
          { id: 'U', kind: 'point' as const, x: 2, y: 3, z: 3 },
          { id: 'V', kind: 'point' as const, x: 1, y: 2, z: 4 },
          { id: 'Plane', kind: 'plane' as const, origin: 'O', uPoint: 'U', vPoint: 'V' },
          { id: 'P', kind: 'pointOnPlane' as const, plane: 'Plane', u: 0, v: 0 },
        ],
        parameters: [],
        measurements: [],
        assertions: [],
        presentation: {
          ...source.spec.presentation,
          objects: [],
          measurements: [],
          groups: [],
          rightAngles: [],
        },
        interaction: {
          parameters: [],
          freedoms: [
            {
              id: 'drag',
              kind: 'plane' as const,
              object: 'P',
              u: { min: -10, max: 10, step: 0.1 },
              v: { min: -10, max: 10, step: 0.1 },
            },
          ],
          selectable: [],
          visibleGroups: [],
          reset: 'initial' as const,
        },
      },
    };
    const session = createGeometrySession(envelope, 'oblique');
    try {
      const result = proposeFreedom(
        envelope.spec,
        envelope.spec.interaction.freedoms[0],
        session.getComputedState(),
        [1 + Math.SQRT2, 2 + Math.SQRT2, 6],
      );
      expect(result).toEqual({ u: expect.closeTo(2, 8), v: expect.closeTo(3, 8) });
    } finally {
      session.dispose();
    }
  });
  it('translates only declared edge axes relative to the drag start', () => {
    const envelope = fixture('G5-translation'),
      session = createGeometrySession(envelope, 'translation');
    try {
      const state = session.getComputedState(),
        freedom = envelope.spec.interaction.freedoms[0];
      const value = proposeFreedom(envelope.spec, freedom, state, [3, -2], {
        point: [0, 0],
        value: state.inputs.freedoms[freedom.id],
      });
      expect(value).toEqual({ x: 3, y: -2 });
      session.applyCommand({ schemaVersion: version, kind: 'setFreedom', id: freedom.id, value });
      expect(session.getComputedState().measurements.length.value).toBeCloseTo(3);
      expect(proposeFreedom(envelope.spec, freedom, state, [NaN, 0])).toBeNull();
    } finally {
      session.dispose();
    }
  });
  it('camera zoom and orbit preserve reference point and radius', () => {
    expect(zoomGeometryCamera({ kind: 'planar', bounds: [-4, -2, 4, 2] }, 2)).toEqual({
      kind: 'planar',
      bounds: [-2, -1, 2, 1],
    });
    const camera = {
      kind: 'spatial' as const,
      projection: 'perspective' as const,
      position: [5, 4, 7] as const,
      target: [1, 2, 3] as const,
      up: [0, 0, 1] as const,
      zoom: 1,
    };
    const after = orbitGeometryCamera(camera, 0.7, 0.2);
    expect(after.kind).toBe('spatial');
    if (after.kind !== 'spatial') throw new Error('spatial');
    expect(after.target).toEqual(camera.target);
    expect(Math.hypot(...after.position.map((x, i) => x - after.target[i]))).toBeCloseTo(6);
    expect(zoomGeometryCamera(camera, 1000)).toMatchObject({ zoom: 100 });
  });
});

describe('geometry facade controls and lifecycle', () => {
  let dom: JSDOM;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let target: HTMLElement;
  const controllers: GeometryScienceKitController[] = [];
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="target"></div>', { pretendToBeVisual: true });
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    target = dom.window.document.querySelector('#target')!;
    vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 500,
      left: 0,
      top: 0,
      right: 800,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON() {},
    });
  });
  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.destroy());
    dom.window.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const shownFixture = () => {
    const source = fixture('G3-pyramid');
    return {
      ...source,
      spec: {
        ...source.spec,
        presentation: {
          ...source.spec.presentation,
          measurements: source.spec.measurements.map((item) => ({ measurement: item.id })),
        },
      },
    };
  };
  const mount = (
    source = shownFixture(),
    options: Partial<GeometryView> = {},
    messages: Readonly<Record<string, string>> = GEOMETRY_MESSAGE_DEFAULTS,
  ) => {
    const view: GeometryView = {
      paint: vi.fn(),
      resize: vi.fn(),
      pick: () => null,
      project: (p) => [p[0], p[1]],
      dragPoint: (p) => [p[0], p[1], 0],
      orbit: orbitGeometryCamera,
      dispose: vi.fn(),
      ...options,
    };
    const controller = mountGeometry(
      target,
      { instanceId: 'geometry-test', envelope: source, locale: 'en-US', messages },
      () => view,
    );
    controllers.push(controller);
    flush();
    return { controller, view };
  };
  it('emits bounded changes only for actual API/control mutations, never restore', () => {
    const changes: unknown[] = [];
    target.addEventListener('reach-science-kit-change', (event) =>
      changes.push((event as CustomEvent).detail),
    );
    const { controller } = mount();
    const initial = controller.getState();
    expect(
      controller.applyCommand({ schemaVersion: version, kind: 'setParameter', id: 'h', value: 6 }),
    ).toMatchObject({ ok: true, changed: true });
    flush();
    expect(changes).toEqual([
      {
        instanceId: 'geometry-test',
        revision: 1,
        source: 'api',
        kind: 'setParameter',
        inputKeys: ['parameter:h', 'freedom:dragP'],
        viewKeys: [],
      },
    ]);
    controller.applyCommand({ schemaVersion: version, kind: 'setParameter', id: 'h', value: 6 });
    flush();
    expect(changes).toHaveLength(1);
    const input = target.querySelector<HTMLInputElement>('[data-geometry-input="parameter:h"]')!;
    input.value = '7';
    input.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ source: 'control', revision: 2 });
    expect(controller.setState(initial)).toBe(true);
    flush();
    expect(changes).toHaveLength(2);
    expect(controller.getComputedState().inputs.parameters.h).toBe(4);
    expect(controller.setState({})).toBe(false);
    expect(changes).toHaveLength(2);
    controller.reset();
    flush();
    expect(changes).toHaveLength(2);
  });
  it('rejects invalid numeric input and shows only declared visible measurements', () => {
    const source = shownFixture();
    const envelope = {
      ...source,
      spec: {
        ...source.spec,
        presentation: {
          ...source.spec.presentation,
          measurements: source.spec.presentation.measurements.map((measurement, index) => ({
            ...measurement,
            visible: index === 0,
          })),
        },
      },
    };
    const { controller } = mount(envelope),
      before = controller.getComputedState();
    const input = target.querySelector<HTMLInputElement>('[data-geometry-input="parameter:h"]')!;
    input.value = '1000';
    input.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(controller.getComputedState()).toEqual(before);
    expect(target.querySelectorAll('[data-geometry-measurement]')).toHaveLength(1);
    input.dispatchEvent(new dom.window.Event('blur'));
    expect(input.value).toBe('4');
  });
  it('coalesces empty-space orbit while any visible hit suppresses orbit', () => {
    let hit = true;
    const { controller } = mount(undefined, {
      pick: () => (hit ? { objectId: 'AB', selectable: false } : null),
    });
    const scene = target.querySelector('.reach-geometry-scene')!;
    const pointer = (type: string, x: number, y: number) => {
      const event = new dom.window.MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
      scene.dispatchEvent(event);
    };
    const before = controller.getComputedState().camera;
    pointer('pointerdown', 300, 200);
    pointer('pointermove', 320, 220);
    pointer('pointerup', 320, 220);
    flush();
    expect(controller.getComputedState().camera).toEqual(before);
    hit = false;
    pointer('pointerdown', 300, 200);
    pointer('pointermove', 310, 200);
    pointer('pointermove', 320, 210);
    pointer('pointermove', 340, 220);
    expect(controller.getComputedState().camera).toEqual(before);
    flush();
    expect(controller.getComputedState().camera).not.toEqual(before);
    expect(controller.getComputedState().geometryRevision).toBe(0);
    pointer('pointerup', 340, 220);
    flush();
  });
  it('pauses pending work on suspend and disposes listeners, view and session', () => {
    const { controller, view } = mount();
    const zoom = target.querySelector<HTMLButtonElement>('[data-geometry-action="zoomIn"]')!;
    dom.window.dispatchEvent(new dom.window.Event('reach-interactive-suspend'));
    expect(zoom.disabled).toBe(true);
    expect(frames.size).toBe(0);
    const before = controller.getComputedState();
    zoom.click();
    expect(controller.getComputedState()).toEqual(before);
    dom.window.dispatchEvent(new dom.window.Event('reach-interactive-resume'));
    flush();
    expect(zoom.disabled).toBe(false);
    expect(view.resize).toHaveBeenCalled();
    zoom.click();
    expect(frames.size).toBe(1);
    controller.destroy();
    expect(frames.size).toBe(0);
    expect(view.dispose).toHaveBeenCalledTimes(1);
    expect(target.childElementCount).toBe(0);
    dom.window.dispatchEvent(new dom.window.Event('reach-interactive-resume'));
    expect(frames.size).toBe(0);
    expect(controller.applyCommand({ schemaVersion: version, kind: 'reset' })).toMatchObject({
      ok: false,
    });
  });
  it('uses translated visible and accessible controls without runtime text fallbacks', () => {
    const messages = Object.fromEntries(
      Object.entries(GEOMETRY_MESSAGE_DEFAULTS).map(([key, value]) => [key, `translated:${value}`]),
    );
    mount(undefined, {}, messages);
    expect(target.querySelector('[data-geometry-action="reset"]')!.getAttribute('aria-label')).toBe(
      'translated:Reset',
    );
    expect(target.querySelector('[data-geometry-selection]')!.getAttribute('aria-label')).toBe(
      'translated:Selected object',
    );
    expect(target.textContent).toContain('translated:Parameters');
    expect(target.textContent).toContain('translated:degrees');
  });
  it('reports renderer failure and releases partially mounted resources', () => {
    const error = vi.fn();
    Object.assign(dom.window, { ReachInteractive: { error } });
    expect(() =>
      mountGeometry(
        target,
        {
          instanceId: 'failed',
          envelope: fixture('G3-pyramid'),
          locale: 'en-US',
          messages: GEOMETRY_MESSAGE_DEFAULTS,
        },
        () => {
          throw new Error('no WebGL');
        },
      ),
    ).toThrow('no WebGL');
    expect(error).toHaveBeenCalledWith({ code: 'geometry_renderer_unavailable' });
    expect(target.querySelector('[role="alert"]')!.textContent).toBe(
      'Geometry view is unavailable',
    );
  });
  it('keeps failed controls disabled after resume and rejects any subsequent mutation', () => {
    let fail!: () => void;
    const source = shownFixture();
    const envelope = {
      ...source,
      spec: {
        ...source.spec,
        presentation: {
          ...source.spec.presentation,
          groups: [{ id: 'points', objects: ['P'], measurements: [] }],
        },
        interaction: { ...source.spec.interaction, visibleGroups: ['points'] },
      },
    };
    const controller = mountGeometry(
      target,
      { instanceId: 'loss', envelope, locale: 'en-US', messages: GEOMETRY_MESSAGE_DEFAULTS },
      (_scene, _envelope, _engine, failure) => {
        fail = failure;
        return {
          paint() {},
          resize() {},
          pick: () => null,
          project: () => null,
          dragPoint: () => null,
          orbit: (camera) => camera,
          dispose() {},
        };
      },
    );
    controllers.push(controller);
    flush();
    const before = controller.getComputedState(),
      change = vi.fn();
    target.addEventListener('reach-science-kit-change', change);
    fail();
    dom.window.dispatchEvent(new dom.window.Event('reach-interactive-resume'));
    for (const control of target.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >('input,select,button'))
      expect(control.disabled).toBe(true);
    const input = target.querySelector<HTMLInputElement>('[data-geometry-input="parameter:h"]')!;
    input.value = '6';
    input.dispatchEvent(new dom.window.Event('change'));
    const selection = target.querySelector<HTMLSelectElement>('[data-geometry-selection]')!;
    selection.value = 'P';
    selection.dispatchEvent(new dom.window.Event('change'));
    const group = target.querySelector<HTMLInputElement>('[data-geometry-group]')!;
    group.checked = false;
    group.dispatchEvent(new dom.window.Event('change'));
    expect(
      controller.applyCommand({ schemaVersion: version, kind: 'setParameter', id: 'h', value: 6 }),
    ).toMatchObject({ ok: false });
    flush();
    expect(controller.getComputedState()).toEqual(before);
    expect(change).not.toHaveBeenCalled();
  });
  it('preserves authored target dimensions', () => {
    target.style.height = '320px';
    target.style.minHeight = '260px';
    target.style.width = '420px';
    mount();
    expect(target.style.height).toBe('320px');
    expect(target.style.minHeight).toBe('260px');
    expect(target.style.width).toBe('420px');
  });
});
