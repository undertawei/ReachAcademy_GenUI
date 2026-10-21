import scenario from '../../reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GeometryAuxiliaryStateV2,
  GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { createGeometrySessionV2 } from '@reachany/reach-deck-geometry/session-v2';
import { GEOMETRY_MESSAGE_DEFAULTS } from '../src/geometryMessages.js';
import {
  geometryRelationMessageKeyV2,
  mountGeometryV2,
  geometryPointOnLineRangeV2,
  type GeometryMountContextV2,
  type GeometryScienceKitControllerV2,
} from '../scripts/geometry-runtime-v2';
import type { GeometryViewV2 } from '../scripts/geometry-spatial-v2';

const fixture = scenario as unknown as {
  envelope: GeometryEnvelopeV2;
  auxiliary: GeometryAuxiliaryStateV2;
};

describe('geometry v2 Player exploration runtime', () => {
  it('distinguishes supporting-line intersections outside declared segment domains', () => {
    expect(
      geometryRelationMessageKeyV2({
        kind: 'lineLine',
        status: 'valid',
        reason: null,
        classification: 'intersecting',
        intersectsDeclaredDomains: false,
        intersection: [2, 0],
        line1Parameter: 2,
        line2Parameter: 2,
      }),
    ).toBe('relation.intersectionOutsideLineDomains');
    expect(
      geometryRelationMessageKeyV2({
        kind: 'linePlane',
        status: 'valid',
        reason: null,
        classification: 'intersecting',
        intersectsDeclaredDomain: false,
        intersection: [2, 0, 0],
        lineParameter: 2,
      }),
    ).toBe('relation.intersectionOutsideLineDomain');
  });

  it('keeps points on segments and rays inside their declared domains', () => {
    expect(geometryPointOnLineRangeV2('segment')).toEqual({ min: 0, max: 1, step: 0.05 });
    expect(geometryPointOnLineRangeV2('ray')).toEqual({ min: 0, max: 10, step: 0.05 });
    expect(geometryPointOnLineRangeV2('line')).toEqual({ min: -10, max: 10, step: 0.05 });
  });
  let dom: JSDOM;
  let target: HTMLElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const controllers: GeometryScienceKitControllerV2[] = [];

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="target" style="height:500px"></div>', {
      pretendToBeVisual: true,
    });
    target = dom.window.document.querySelector('#target')!;
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

  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };

  const mount = (
    context: Partial<GeometryMountContextV2> = {},
    viewOverrides: Partial<GeometryViewV2> = {},
  ) => {
    const view: GeometryViewV2 = {
      paint: vi.fn(),
      rebuild: vi.fn(),
      resize: vi.fn(),
      pickCandidates: () => [],
      project: (point) => [point[0]!, point[1]!],
      dragPoint: (pixel) => pixel,
      orbit: (camera) => camera,
      dispose: vi.fn(),
      ...viewOverrides,
    };
    const onStateChange = vi.fn(() => true);
    const controller = mountGeometryV2(
      target,
      {
        instanceId: 'geometry-v2',
        envelope: structuredClone(fixture.envelope),
        locale: 'en-US',
        messages: GEOMETRY_MESSAGE_DEFAULTS,
        geometryHostMode: 'learner',
        pageId: 'page-1',
        sourceRevision: 3,
        canAdoptState: () => true,
        onStateChange,
        ...context,
      },
      () => view,
    );
    controllers.push(controller);
    flush();
    return { controller, view, onStateChange };
  };

  const select = (value: string) => {
    const control = target.querySelector<HTMLSelectElement>('[data-geometry-selection]')!;
    control.value = value;
    control.dispatchEvent(new dom.window.Event('change'));
    flush();
  };

  const restrictiveEnvelope = (withBindings = true): GeometryEnvelopeV2 => {
    const { authoring, ...specWithoutAuthoring } = fixture.envelope.spec;
    const envelope: GeometryEnvelopeV2 = {
      ...fixture.envelope,
      spec: {
        ...specWithoutAuthoring,
        interaction: {
          ...fixture.envelope.spec.interaction,
          exploration: {
            objectKinds: [],
            measurementKinds: [],
            relationKinds: [],
            referenceableObjects: ['A'],
            limits: { objects: 0, measurements: 0, relations: 0 },
            feedback: 'hidden',
          },
        },
        ...(withBindings ? { authoring } : {}),
      },
    };
    return envelope;
  };

  it('constructs a policy-allowed segment, rebuilds on modelRevision, and undo/redoes it', () => {
    const { controller, view, onStateChange } = mount();
    target.querySelector<HTMLButtonElement>('[data-geometry-tool="tool.segment"]')!.click();
    select('A');
    select('B');

    expect(controller.getState().auxiliary.objects).toEqual([
      expect.objectContaining({ id: 'L_O1', kind: 'segment', a: 'A', b: 'B' }),
    ]);
    expect(view.rebuild).toHaveBeenLastCalledWith(expect.objectContaining({ modelRevision: 1 }));
    expect(onStateChange).toHaveBeenCalled();

    target.querySelector<HTMLButtonElement>('[data-geometry-action="undo"]')!.click();
    flush();
    expect(controller.getState().auxiliary.objects).toEqual([]);
    target.querySelector<HTMLButtonElement>('[data-geometry-action="redo"]')!.click();
    flush();
    expect(controller.getState().auxiliary.objects).toHaveLength(1);
  });

  it('localizes learner-created measurement and relation labels without persisting UI copy', () => {
    const { controller } = mount();
    target.querySelector<HTMLButtonElement>('[data-geometry-tool="tool.distance"]')!.click();
    select('A');
    select('B');
    target
      .querySelector<HTMLButtonElement>('[data-geometry-tool="tool.lineLineRelation"]')!
      .click();
    select('AB');
    select('AP');

    expect(controller.getState().auxiliary.presentation).toMatchObject({
      measurements: [{ measurement: 'L_M1' }],
      relations: [{ relation: 'L_R1', visible: true }],
    });
    expect(controller.getState().auxiliary.presentation.measurements[0]).not.toHaveProperty(
      'label',
    );
    expect(controller.getState().auxiliary.presentation.relations[0]).not.toHaveProperty('label');
    expect(target.querySelector('[data-geometry-measurement="L_M1"] span')?.textContent).toBe(
      'Distance between two points',
    );
    expect(target.querySelector('[data-geometry-relation="L_R1"] span')?.textContent).toBe(
      'Check two-line relation',
    );
    expect(target.querySelector<HTMLOptionElement>('option[value="L_M1"]')?.textContent).toBe(
      'Distance between two points',
    );
    expect(target.querySelector<HTMLOptionElement>('option[value="L_R1"]')?.textContent).toBe(
      'Check two-line relation',
    );
  });

  it('reveals on-request feedback only after checking and locks it after geometry changes', () => {
    const { controller } = mount();
    expect(
      controller.applyCommand({
        schemaVersion: 'reach-geometry-command/v2',
        kind: 'addAuxiliary',
        auxiliary: fixture.auxiliary,
      }),
    ).toMatchObject({ ok: true, changed: true });
    flush();

    const height = () =>
      target.querySelector<HTMLOutputElement>('[data-geometry-measurement="L_height"] output')!;
    const relation = () =>
      target.querySelector<HTMLOutputElement>('[data-geometry-relation="L_position"] output')!;
    expect(height().textContent).toBe('Not checked');
    expect(relation().textContent).toBe('Not checked');

    target.querySelector<HTMLButtonElement>('[data-geometry-action="checkResults"]')!.click();
    flush();
    expect(height().textContent).toBe('4.00 cm');
    expect(relation().textContent).toBe('Intersecting');

    controller.applyCommand({
      schemaVersion: 'reach-geometry-command/v2',
      kind: 'setFreedom',
      id: 'L_dragOn',
      value: 0.75,
    });
    flush();
    expect(height().textContent).toBe('Not checked');
    expect(relation().textContent).toBe('Not checked');
  });

  it('previews the complete page state and rejects an over-budget command atomically', () => {
    const before = structuredClone(fixture.envelope);
    const { controller, onStateChange } = mount({ canAdoptState: () => false });
    const result = controller.applyCommand({
      schemaVersion: 'reach-geometry-command/v2',
      kind: 'addAuxiliary',
      auxiliary: fixture.auxiliary,
    });
    expect(result).toEqual({ ok: false, code: 'state_bytes_exceeded' });
    expect(controller.getState().auxiliary).toEqual({
      objects: [],
      measurements: [],
      relations: [],
      freedoms: [],
      presentation: { objects: [], measurements: [], relations: [] },
    });
    expect(controller.getComputedState().revision).toBe(0);
    expect(onStateChange).not.toHaveBeenCalled();
    expect(before).toEqual(fixture.envelope);
  });

  it('offers an explicit candidate chooser and cancels unfinished tools with Escape', () => {
    const { controller } = mount({}, { pickCandidates: () => ['A', 'B'] });
    const scene = target.querySelector<HTMLElement>('[data-geometry-surface]')!;
    const pointer = new dom.window.MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 20,
      clientY: 30,
      button: 0,
    });
    Object.defineProperties(pointer, {
      pointerId: { value: 1 },
      pointerType: { value: 'touch' },
    });
    scene.dispatchEvent(pointer);
    const chooser = target.querySelector<HTMLSelectElement>(
      'select[aria-label="Choose an object at this position"]',
    )!;
    expect(chooser.hidden).toBe(false);
    chooser.value = 'B';
    chooser.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(controller.getState().selection).toBe('B');

    const tool = target.querySelector<HTMLButtonElement>('[data-geometry-tool="tool.segment"]')!;
    tool.click();
    expect(tool.getAttribute('aria-pressed')).toBe('true');
    target
      .querySelector<HTMLElement>('.reach-geometry-v2')!
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tool.getAttribute('aria-pressed')).toBe('false');
  });

  it('confirms and removes the complete auxiliary dependency closure in one operation', () => {
    const { controller } = mount();
    expect(
      controller.applyCommand({
        schemaVersion: 'reach-geometry-command/v2',
        kind: 'addAuxiliary',
        auxiliary: fixture.auxiliary,
      }).ok,
    ).toBe(true);
    flush();
    select('L_M');
    target.querySelector<HTMLButtonElement>('[data-geometry-action="delete"]')!.click();
    const confirmation = target.querySelector<HTMLElement>('[data-geometry-confirmation]')!;
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.textContent).toContain('L_PM');
    target.querySelector<HTMLButtonElement>('[data-geometry-confirmation-accept]')!.click();
    flush();
    expect(controller.getState().auxiliary.objects.map((object) => object.id)).not.toContain(
      'L_PM',
    );
    target.querySelector<HTMLButtonElement>('[data-geometry-action="undo"]')!.click();
    flush();
    expect(controller.getState().auxiliary).toEqual(fixture.auxiliary);
  });

  it('confirms, clears, and restores every auxiliary item through undo', () => {
    const { controller } = mount();
    expect(
      controller.applyCommand({
        schemaVersion: 'reach-geometry-command/v2',
        kind: 'addAuxiliary',
        auxiliary: fixture.auxiliary,
      }).ok,
    ).toBe(true);
    flush();
    const clear = target.querySelector<HTMLButtonElement>(
      '[data-geometry-action="clearAuxiliary"]',
    )!;
    clear.click();
    const confirmation = target.querySelector<HTMLElement>('[data-geometry-confirmation]')!;
    expect(confirmation.hidden).toBe(false);
    target.querySelector<HTMLButtonElement>('[data-geometry-confirmation-cancel]')!.click();
    expect(confirmation.hidden).toBe(true);
    expect(controller.getState().auxiliary).toEqual(fixture.auxiliary);

    clear.click();
    target.querySelector<HTMLButtonElement>('[data-geometry-confirmation-accept]')!.click();
    flush();
    expect(controller.getState().auxiliary).toEqual({
      objects: [],
      measurements: [],
      relations: [],
      freedoms: [],
      presentation: { objects: [], measurements: [], relations: [] },
    });
    target.querySelector<HTMLButtonElement>('[data-geometry-action="undo"]')!.click();
    flush();
    expect(controller.getState().auxiliary).toEqual(fixture.auxiliary);
  });

  it('reselects and deletes an auxiliary measurement after selecting another item', () => {
    const { controller } = mount();
    expect(
      controller.applyCommand({
        schemaVersion: 'reach-geometry-command/v2',
        kind: 'addAuxiliary',
        auxiliary: fixture.auxiliary,
      }).ok,
    ).toBe(true);
    flush();
    select('A');
    select('L_height');
    target.querySelector<HTMLButtonElement>('[data-geometry-action="delete"]')!.click();
    flush();

    expect(controller.getState().auxiliary.measurements.map((entry) => entry.id)).not.toContain(
      'L_height',
    );
    expect(controller.getState().auxiliary.objects).toHaveLength(fixture.auxiliary.objects.length);
  });

  it('marks the actual host mode and restores without emitting a change proposal', () => {
    const { controller, onStateChange } = mount({ geometryHostMode: 'authoring-trial' });
    const saved = structuredClone(controller.getState());
    expect(controller.setState(saved)).toBe(true);
    flush();
    expect(target.querySelector('[data-geometry-host-mode="authoring-trial"]')).not.toBeNull();
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('exposes canonical tools only for bound authoring edit sessions', () => {
    for (const geometryHostMode of ['learner', 'authoring-trial'] as const) {
      mount({ envelope: restrictiveEnvelope(), geometryHostMode });
      expect(target.querySelector('[data-geometry-tool="tool.segment"]')).toBeNull();
    }
    mount({ envelope: restrictiveEnvelope(false), geometryHostMode: 'authoring-edit' });
    expect(target.querySelector('[data-geometry-tool="tool.segment"]')).toBeNull();

    const { controller } = mount({
      envelope: restrictiveEnvelope(),
      geometryHostMode: 'authoring-edit',
    });
    target.querySelector<HTMLButtonElement>('[data-geometry-tool="tool.segment"]')!.click();
    select('A');
    select('B');
    expect(controller.getState().auxiliary.objects).toEqual([
      expect.objectContaining({ kind: 'segment', a: 'A', b: 'B' }),
    ]);
  });

  it('can build from an auxiliary object promoted by the previous authoring proposal', () => {
    const base = restrictiveEnvelope();
    const envelope: GeometryEnvelopeV2 = {
      ...base,
      spec: {
        ...base.spec,
        objects: [...base.spec.objects, { id: 'A_M', kind: 'midpoint', a: 'A', b: 'B' }],
        presentation: {
          ...base.spec.presentation,
          objects: [...base.spec.presentation.objects, { object: 'A_M', label: 'M' }],
        },
        interaction: {
          ...base.spec.interaction,
          selectable: [...base.spec.interaction.selectable, 'A_M'],
        },
        authoring: {
          ...base.spec.authoring!,
          editable: {
            ...base.spec.authoring!.editable,
            objects: [...base.spec.authoring!.editable.objects, 'A_M'],
          },
          deletable: {
            ...base.spec.authoring!.deletable,
            objects: [...base.spec.authoring!.deletable.objects, 'A_M'],
          },
        },
      },
    };

    const { controller } = mount({ envelope, geometryHostMode: 'authoring-edit' });
    target.querySelector<HTMLButtonElement>('[data-geometry-tool="tool.segment"]')!.click();
    select('A_M');
    select('P');
    expect(controller.getState().auxiliary.objects).toEqual([
      expect.objectContaining({ kind: 'segment', a: 'A_M', b: 'P' }),
    ]);
  });

  it('applies the authored initial view before a silent host restore overrides it', () => {
    const baseline = createGeometrySessionV2(fixture.envelope, 'geometry-v2');
    const initial = baseline.getState();
    baseline.dispose();
    const authoredCamera = { kind: 'planar' as const, bounds: [-3, -2, 9, 8] as const };
    const { controller, onStateChange } = mount({
      authoredSnapshot: {
        schemaVersion: 'reach-geometry-authored-snapshot/v1',
        instanceId: 'geometry-v2',
        fingerprint: initial.fingerprint,
        inputs: initial.inputs,
        camera: authoredCamera,
      },
    });
    expect(controller.getComputedState().camera).toEqual(authoredCamera);
    expect(onStateChange).not.toHaveBeenCalled();

    const restoredCamera = { kind: 'planar' as const, bounds: [-6, -5, 12, 10] as const };
    expect(controller.setState({ ...controller.getState(), camera: restoredCamera })).toBe(true);
    flush();
    expect(controller.getComputedState().camera).toEqual(restoredCamera);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('resets parameters and camera to the authored initial snapshot', () => {
    const baseline = createGeometrySessionV2(fixture.envelope, 'geometry-v2');
    const initial = baseline.getState();
    baseline.dispose();
    const authoredCamera = { kind: 'planar' as const, bounds: [-3, -2, 9, 8] as const };
    const authoredInputs = initial.inputs;
    const { controller } = mount({
      authoredSnapshot: {
        schemaVersion: 'reach-geometry-authored-snapshot/v1',
        instanceId: 'geometry-v2',
        fingerprint: initial.fingerprint,
        inputs: authoredInputs,
        camera: authoredCamera,
      },
    });
    expect(
      controller.applyCommand({
        schemaVersion: 'reach-geometry-command/v2',
        kind: 'addAuxiliary',
        auxiliary: fixture.auxiliary,
      }).ok,
    ).toBe(true);
    expect(
      controller.applyCommand({
        schemaVersion: 'reach-geometry-command/v2',
        kind: 'setCamera',
        camera: { kind: 'planar', bounds: [-8, -7, 14, 12] },
      }).ok,
    ).toBe(true);

    expect(
      controller.applyCommand({ schemaVersion: 'reach-geometry-command/v2', kind: 'reset' }).ok,
    ).toBe(true);
    expect(controller.getState()).toMatchObject({
      inputs: authoredInputs,
      camera: authoredCamera,
      auxiliary: { objects: [], measurements: [], relations: [] },
    });
  });
});
