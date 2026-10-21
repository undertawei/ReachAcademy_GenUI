import {
  createElement,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
} from 'lucide';
import { createGeometryEngine, type GeometryEngine } from '@reachany/reach-deck-geometry';
import {
  createGeometrySession,
  isGeometryItemVisible,
  type GeometryComputedState,
  type GeometrySession,
  type GeometrySessionCommand,
  type GeometrySessionResult,
} from '@reachany/reach-deck-geometry/session';
import {
  parseGeometryEnvelope,
  type GeometryEnvelope,
  type GeometryFreedom,
  type GeometryRange,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import type { ScienceKitController, ScienceKitMount } from './science-kit-runtime.shared';
import {
  proposeFreedom,
  zoomGeometryCamera,
  type GeometryView,
  type Pixel,
  type World,
} from './geometry-interaction';

export interface GeometryMountContext {
  readonly instanceId: string;
  readonly envelope: unknown;
  readonly locale: string;
  readonly messages: Readonly<Record<string, string>>;
}
export interface GeometryScienceKitController extends ScienceKitController {
  getComputedState(): GeometryComputedState;
  applyCommand(command: unknown): GeometrySessionResult;
}
export type GeometryViewFactory = (
  scene: HTMLElement,
  envelope: GeometryEnvelope,
  engine: GeometryEngine,
  fail: () => void,
) => GeometryView;
const prefix = 'reachDeck.geometry.';
const commandVersion = 'reach-geometry-command/v1';
const css = `
.reach-geometry{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;position:relative;overflow:hidden;background:#fff;color:#172033;font:13px/1.4 system-ui,sans-serif;letter-spacing:0;container-type:inline-size}
.reach-geometry *{box-sizing:border-box;letter-spacing:0}
.reach-geometry-scene{position:relative;flex:1 1 auto;min-height:100px;min-width:0;overflow:hidden;touch-action:none;background:#f8fafc;outline-offset:-3px}
.reach-geometry-scene canvas{display:block;width:100%;height:100%}
.reach-geometry-toolbar{display:flex;flex:none;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #dce1e6;min-height:46px;flex-wrap:wrap}
.reach-geometry button{display:inline-flex;align-items:center;justify-content:center;flex:0 0 34px;width:34px;height:34px;padding:7px;background:#fff;border:1px solid #cbd2db;border-radius:4px;color:#334155;cursor:pointer}
.reach-geometry button:hover{background:#eaf1fa}.reach-geometry button:disabled{opacity:.45;cursor:default}
.reach-geometry button svg{width:18px;height:18px;flex:none}
.reach-geometry button:focus-visible,.reach-geometry input:focus-visible,.reach-geometry select:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.reach-geometry-select{display:flex;align-items:center;gap:6px;margin-left:auto;min-width:0;max-width:100%}
.reach-geometry select{height:32px;width:130px;max-width:100%;border:1px solid #cbd2db;background:#fff;border-radius:4px;color:inherit;font:inherit;padding:3px 6px}
.reach-geometry-controls{flex:none;max-height:34%;overflow:auto;display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 16px;padding:8px;border-top:1px solid #dce1e6;background:#fff}
.reach-geometry-fieldset{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;border:0;padding:0;margin:0;min-width:0;max-width:100%}
.reach-geometry-fieldset legend{font-size:11px;color:#526174;margin-bottom:3px;padding:0;max-width:100%;overflow-wrap:anywhere}
.reach-geometry-field{display:flex;align-items:center;gap:5px;max-width:100%;min-height:30px}
.reach-geometry-field span{overflow-wrap:anywhere;max-width:160px}
.reach-geometry input[type=number]{width:82px;min-width:0;height:30px;padding:3px 5px;border:1px solid #cbd2db;border-radius:3px;font:inherit;color:inherit;background:#fff}
.reach-geometry input[type=checkbox]{accent-color:#2563eb;width:16px;height:16px;margin:0}
.reach-geometry input[aria-invalid=true]{border-color:#b91c1c}
.reach-geometry-measurements{display:flex;flex:none;gap:6px 18px;flex-wrap:wrap;max-height:22%;overflow:auto;padding:7px 10px;border-top:1px solid #dce1e6;background:#f0f7f3}
.reach-geometry-measurements[hidden],.reach-geometry-controls[hidden]{display:none}
.reach-geometry-reading{display:flex;align-items:baseline;gap:8px;min-width:0;max-width:100%;flex-wrap:wrap}
.reach-geometry-reading span{overflow-wrap:anywhere}.reach-geometry-reading output{font-variant-numeric:tabular-nums;font-weight:600;max-width:100%;overflow-wrap:anywhere}
.reach-geometry-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;color:#9f1239;padding:20px;text-align:center}
.reach-geometry-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.reach-geometry-label{position:absolute;font-size:13px;line-height:18px;font-weight:600;max-width:160px;overflow-wrap:anywhere;text-shadow:0 1px 2px #fff,1px 0 2px #fff;pointer-events:none}
@container(max-width:480px){.reach-geometry-toolbar{gap:4px;padding:4px}.reach-geometry-select{flex:1 1 100%;margin-left:0}.reach-geometry-select select{flex:1}.reach-geometry-controls{max-height:36%;gap:6px 12px}.reach-geometry-field span{max-width:105px}.reach-geometry-measurements{font-size:12px;gap:5px 12px}}
`;

export function mountGeometry(
  target: HTMLElement,
  context: GeometryMountContext,
  factory: GeometryViewFactory,
): GeometryScienceKitController {
  const { envelope } = parseGeometryEnvelope(context.envelope);
  const spec = envelope.spec;
  const t = (key: string): string => {
    const message = context.messages[prefix + key];
    if (typeof message !== 'string') throw new Error(`Missing geometry message: ${key}`);
    return message;
  };
  const doc = target.ownerDocument;
  target.replaceChildren();
  const authoredSize = doc.defaultView!.getComputedStyle(target);
  if (
    !target.style.height &&
    !(Number.parseFloat(authoredSize.height) > 0) &&
    !(Number.parseFloat(authoredSize.minHeight) > 0)
  )
    target.style.height = '100%';
  const style = doc.createElement('style');
  style.textContent = css;
  const root = doc.createElement('div');
  root.className = 'reach-geometry';
  if (Number.parseFloat(authoredSize.minHeight) > 0) root.style.minHeight = authoredSize.minHeight;
  root.dataset.geometryInstance = context.instanceId;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', spec.ariaLabel);
  const toolbar = doc.createElement('div');
  toolbar.className = 'reach-geometry-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', t('controls'));
  const scene = doc.createElement('div');
  scene.className = 'reach-geometry-scene';
  scene.dataset.geometrySurface = '';
  scene.tabIndex = 0;
  scene.setAttribute('role', 'application');
  scene.setAttribute('aria-label', spec.ariaLabel);
  const controls = doc.createElement('div');
  controls.className = 'reach-geometry-controls';
  controls.setAttribute('aria-label', t('parameters'));
  const readings = doc.createElement('div');
  readings.className = 'reach-geometry-measurements';
  readings.setAttribute('aria-label', t('measurements'));
  root.append(toolbar, scene, readings, controls);
  target.append(style, root);
  let disposed = false,
    suspended = false,
    failed = false,
    frame: number | undefined;
  let engine: GeometryEngine | undefined,
    session: GeometrySession | undefined,
    view: GeometryView | undefined;
  const cleanups: (() => void)[] = [];
  const listen = (
    element: EventTarget,
    name: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) => {
    element.addEventListener(name, listener, options);
    cleanups.push(() => element.removeEventListener(name, listener, options));
  };
  const failure = () => {
    if (failed || disposed) return;
    failed = true;
    root.querySelectorAll('button,input,select').forEach((element) => {
      (element as HTMLInputElement).disabled = true;
    });
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    const error = doc.createElement('div');
    error.className = 'reach-geometry-error';
    error.setAttribute('role', 'alert');
    error.textContent = t('rendererUnavailable');
    scene.append(error);
    const interactive = (
      window as unknown as { ReachInteractive?: { error(payload: { code: string }): unknown } }
    ).ReachInteractive;
    interactive?.error({ code: 'geometry_renderer_unavailable' });
  };
  const label = (id: string) =>
    spec.presentation.objects.find((item) => item.object === id)?.label ?? id;
  const numberFields: { input: HTMLInputElement; current(state: GeometryComputedState): number }[] =
    [];
  const groupFields: { id: string; input: HTMLInputElement }[] = [];
  let selection: HTMLSelectElement;
  let pending: GeometrySessionCommand | undefined;
  const dispatch = (result: GeometrySessionResult, source: 'control' | 'api') => {
    if (result.ok && result.changed && result.change)
      target.dispatchEvent(
        new CustomEvent('reach-science-kit-change', {
          detail: {
            instanceId: context.instanceId,
            revision: result.revision,
            source,
            ...result.change,
          },
        }),
      );
  };
  const format = (value: number, decimals: number) =>
    new Intl.NumberFormat(context.locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      ...(Math.abs(value) >= 1e9 ? { notation: 'scientific' as const } : {}),
    }).format(value);
  const paint = () => {
    if (!session || !view || disposed || suspended || failed) return;
    const state = session.getComputedState();
    view.paint(state);
    for (const field of numberFields) {
      if (doc.activeElement !== field.input) field.input.value = String(field.current(state));
    }
    for (const field of groupFields) field.input.checked = state.visibleGroups.includes(field.id);
    selection.value = state.selection ?? '';
    for (const option of Array.from(selection.options))
      if (option.value)
        option.disabled =
          !isGeometryItemVisible(spec.presentation, state.visibleGroups, 'object', option.value) ||
          state.objects[option.value].status !== 'valid';
    readings.replaceChildren();
    for (const item of spec.presentation.measurements) {
      if (
        !isGeometryItemVisible(
          spec.presentation,
          state.visibleGroups,
          'measurement',
          item.measurement,
        )
      )
        continue;
      const measured = state.measurements[item.measurement];
      const row = doc.createElement('div');
      row.className = 'reach-geometry-reading';
      row.dataset.geometryMeasurement = item.measurement;
      const name = doc.createElement('span');
      name.textContent = item.label ?? item.measurement;
      const output = doc.createElement('output');
      if (measured.status === 'valid') {
        output.textContent = `${format(measured.value!, item.decimals ?? 2)} ${t(`unit.${measured.unit}`)}`;
      } else {
        output.textContent = t('undefined');
        output.title = t(`reason.${measured.reason}`);
        output.setAttribute(
          'aria-label',
          `${name.textContent}: ${output.textContent}. ${output.title}`,
        );
      }
      row.append(name, output);
      readings.append(row);
    }
    readings.hidden = readings.childElementCount === 0;
  };
  const schedule = () => {
    if (frame !== undefined || disposed || suspended || failed) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      try {
        if (pending && session) {
          const command = pending;
          pending = undefined;
          dispatch(session.applyCommand({ schemaVersion: commandVersion, ...command }), 'control');
        }
        paint();
      } catch {
        failure();
      }
    });
  };
  const apply = (command: unknown, source: 'control' | 'api'): GeometrySessionResult => {
    if (!session || disposed || failed) return { ok: false, code: 'disposed' };
    pending = undefined;
    const result = session.applyCommand(command);
    dispatch(result, source);
    if (result.ok && result.changed) schedule();
    return result;
  };
  const control = (command: GeometrySessionCommand) =>
    apply({ schemaVersion: commandVersion, ...command }, 'control');
  const icon = (key: string, node: Parameters<typeof createElement>[0], action: () => void) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.title = t(key);
    button.setAttribute('aria-label', t(key));
    button.dataset.geometryAction = key;
    button.append(createElement(node, { 'aria-hidden': 'true', focusable: 'false' }));
    listen(button, 'click', (() => {
      if (!suspended && !failed) action();
    }) as EventListener);
    toolbar.append(button);
  };
  const makeFieldset = (title: string) => {
    const fieldset = doc.createElement('fieldset');
    fieldset.className = 'reach-geometry-fieldset';
    const legend = doc.createElement('legend');
    legend.textContent = title;
    fieldset.append(legend);
    controls.append(fieldset);
    return fieldset;
  };
  const numberField = (
    fieldset: HTMLElement,
    name: string,
    range: GeometryRange,
    current: (state: GeometryComputedState) => number,
    update: (value: number) => GeometrySessionCommand,
    id: string,
  ) => {
    const row = doc.createElement('label');
    row.className = 'reach-geometry-field';
    const caption = doc.createElement('span');
    caption.textContent = name;
    const input = doc.createElement('input');
    input.type = 'number';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.setAttribute('aria-label', name);
    input.dataset.geometryInput = id;
    listen(input, 'change', (() => {
      if (suspended || failed) {
        input.value = String(current(session!.getComputedState()));
        return;
      }
      const value = input.value === '' ? NaN : Number(input.value);
      const result = control(update(value));
      input.setAttribute('aria-invalid', result.ok ? 'false' : 'true');
      input.setCustomValidity(result.ok ? '' : t('invalidInput'));
      if (!result.ok) input.reportValidity();
    }) as EventListener);
    listen(input, 'blur', (() => {
      if (session && !disposed) {
        input.value = String(current(session.getComputedState()));
        input.setCustomValidity('');
        input.removeAttribute('aria-invalid');
      }
    }) as EventListener);
    row.append(caption, input);
    fieldset.append(row);
    numberFields.push({ input, current });
  };
  try {
    engine = createGeometryEngine(
      envelope,
      spec.dimension === 2 ? { planar: { container: scene } } : undefined,
    );
    session = createGeometrySession(envelope, context.instanceId, { engine });
    view = factory(scene, envelope, engine, failure);
    if (failed) throw new Error('geometry_renderer_unavailable');
    icon('reset', RotateCcw, () => control({ kind: 'reset' }));
    icon('zoomIn', ZoomIn, () =>
      control({
        kind: 'setCamera',
        camera: zoomGeometryCamera(session!.getComputedState().camera, 1.2),
      }),
    );
    icon('zoomOut', ZoomOut, () =>
      control({
        kind: 'setCamera',
        camera: zoomGeometryCamera(session!.getComputedState().camera, 1 / 1.2),
      }),
    );
    if (spec.dimension === 3)
      for (const [key, node, dx, dy] of [
        ['rotateLeft', ArrowLeft, -0.15, 0],
        ['rotateRight', ArrowRight, 0.15, 0],
        ['rotateUp', ArrowUp, 0, -0.15],
        ['rotateDown', ArrowDown, 0, 0.15],
      ] as const)
        icon(key, node, () =>
          control({
            kind: 'setCamera',
            camera: view!.orbit(session!.getComputedState().camera, dx, dy),
          }),
        );
    const selectionLabel = doc.createElement('label');
    selectionLabel.className = 'reach-geometry-select';
    const selectionName = doc.createElement('span');
    selectionName.textContent = t('selection');
    selection = doc.createElement('select');
    selection.dataset.geometrySelection = '';
    selection.setAttribute('aria-label', t('selection'));
    const none = doc.createElement('option');
    none.value = '';
    none.textContent = t('none');
    selection.append(none);
    for (const id of spec.interaction.selectable) {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = label(id);
      selection.append(option);
    }
    listen(selection, 'change', (() => {
      if (!suspended && !failed) control({ kind: 'select', objectId: selection.value || null });
    }) as EventListener);
    selectionLabel.append(selectionName, selection);
    if (spec.interaction.selectable.length) toolbar.append(selectionLabel);
    if (spec.interaction.parameters.length) {
      const fields = makeFieldset(t('parameters'));
      for (const id of spec.interaction.parameters) {
        const parameter = spec.parameters.find((item) => item.id === id)!;
        numberField(
          fields,
          id,
          parameter,
          (state) => state.inputs.parameters[id],
          (value) => ({ kind: 'setParameter', id, value }),
          `parameter:${id}`,
        );
      }
    }
    for (const freedom of spec.interaction.freedoms) {
      const fields = makeFieldset(label(freedom.object));
      if (freedom.kind === 'line' || freedom.kind === 'circle')
        numberField(
          fields,
          t('axis.value'),
          freedom.range,
          (state) => state.inputs.freedoms[freedom.id] as number,
          (value) => ({ kind: 'setFreedom', id: freedom.id, value }),
          `freedom:${freedom.id}`,
        );
      else {
        const ranges: readonly { axis: string; range: GeometryRange }[] =
          freedom.kind === 'freePoint'
            ? [
                { axis: 'x', range: freedom.x },
                { axis: 'y', range: freedom.y },
              ]
            : freedom.kind === 'plane'
              ? [
                  { axis: 'u', range: freedom.u },
                  { axis: 'v', range: freedom.v },
                ]
              : freedom.kind === 'translate'
                ? freedom.ranges.map((range) => ({ axis: range.axis, range }))
                : [];
        for (const { axis, range } of ranges)
          numberField(
            fields,
            t(`axis.${axis}`),
            range,
            (state) =>
              (state.inputs.freedoms[freedom.id] as Readonly<Record<string, number>>)[axis],
            (value) => ({
              kind: 'setFreedom',
              id: freedom.id,
              value: {
                ...(session!.getComputedState().inputs.freedoms[freedom.id] as Readonly<
                  Record<string, number>
                >),
                [axis]: value,
              },
            }),
            `freedom:${freedom.id}:${axis}`,
          );
      }
    }
    if (spec.presentation.groups.length) {
      const groups = makeFieldset(t('groups'));
      for (const group of spec.presentation.groups) {
        const row = doc.createElement('label');
        row.className = 'reach-geometry-field';
        const input = doc.createElement('input');
        input.type = 'checkbox';
        input.dataset.geometryGroup = group.id;
        const text = doc.createElement('span');
        text.textContent = group.id;
        row.append(input, text);
        groups.append(row);
        groupFields.push({ id: group.id, input });
        listen(input, 'change', (() => {
          if (!suspended && !failed)
            control({ kind: 'setGroup', id: group.id, visible: input.checked });
        }) as EventListener);
      }
    }
    controls.hidden = controls.childElementCount === 0;
    type Drag = {
      pointerId: number;
      pixel: Pixel;
      initial: GeometryComputedState;
      freedom?: GeometryFreedom;
      anchor?: World;
      start?: { point: World; value: number | Readonly<Record<string, number>> };
      orbit: boolean;
    };
    let drag: Drag | undefined;
    const local = (event: PointerEvent): Pixel => {
      const box = scene.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    const finish = () => {
      if (drag) {
        if (scene.hasPointerCapture?.(drag.pointerId)) scene.releasePointerCapture(drag.pointerId);
        drag = undefined;
      }
    };
    listen(scene, 'pointerdown', ((event: PointerEvent) => {
      if (suspended || failed || event.button !== 0 || drag) return;
      const pixel = local(event),
        state = session!.getComputedState(),
        hit = view!.pick(pixel, event.pointerType === 'mouse' ? 'mouse' : 'touch');
      if (hit?.selectable) control({ kind: 'select', objectId: hit.objectId });
      else if (!hit) control({ kind: 'select', objectId: null });
      const freedom = hit?.freedomId
        ? spec.interaction.freedoms.find((item) => item.id === hit.freedomId)
        : undefined;
      const object = freedom ? state.objects[freedom.object] : undefined;
      const anchor =
        freedom?.kind === 'translate' && object?.origin && object.direction
          ? object.origin.map((value, index) => value + object.direction![index] / 2)
          : (object?.coordinates ?? object?.origin);
      const point = freedom ? view!.dragPoint(pixel, freedom, state, anchor ?? undefined) : null;
      drag = {
        pointerId: event.pointerId,
        pixel,
        initial: state,
        freedom,
        anchor: anchor ?? undefined,
        start: point && freedom ? { point, value: state.inputs.freedoms[freedom.id] } : undefined,
        orbit: !hit && spec.dimension === 3,
      };
      scene.setPointerCapture?.(event.pointerId);
      scene.focus({ preventScroll: true });
      event.preventDefault();
    }) as EventListener);
    listen(scene, 'pointermove', ((event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId || suspended || failed) return;
      const pixel = local(event);
      if (drag.freedom) {
        const point = view!.dragPoint(pixel, drag.freedom, drag.initial, drag.anchor);
        if (point) {
          const value = proposeFreedom(
            spec,
            drag.freedom,
            session!.getComputedState(),
            point,
            drag.start,
          );
          if (value !== null) pending = { kind: 'setFreedom', id: drag.freedom.id, value };
        }
      } else if (drag.orbit)
        pending = {
          kind: 'setCamera',
          camera: view!.orbit(
            drag.initial.camera,
            (pixel[0] - drag.pixel[0]) * 0.008,
            (pixel[1] - drag.pixel[1]) * 0.008,
          ),
        };
      schedule();
      event.preventDefault();
    }) as EventListener);
    listen(scene, 'pointerup', ((event: PointerEvent) => {
      if (event.pointerId === drag?.pointerId) {
        finish();
        schedule();
      }
    }) as EventListener);
    listen(scene, 'pointercancel', (() => {
      pending = undefined;
      finish();
    }) as EventListener);
    listen(scene, 'lostpointercapture', (() => {
      drag = undefined;
    }) as EventListener);
    listen(
      scene,
      'wheel',
      ((event: WheelEvent) => {
        if (suspended || failed) return;
        event.preventDefault();
        pending = {
          kind: 'setCamera',
          camera: zoomGeometryCamera(
            pending?.kind === 'setCamera' ? pending.camera : session!.getComputedState().camera,
            Math.exp(-Math.sign(event.deltaY) * 0.12),
          ),
        };
        schedule();
      }) as EventListener,
      { passive: false },
    );
    const resize = () => {
      if (disposed || suspended || failed) return;
      const box = scene.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        view!.resize(box.width, box.height);
        schedule();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(scene);
    cleanups.push(() => observer.disconnect());
    listen(window, 'reach-interactive-resize', resize as EventListener);
    listen(window, 'reach-interactive-suspend', (() => {
      suspended = true;
      pending = undefined;
      finish();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      root.querySelectorAll('button,input,select').forEach((element) => {
        (element as HTMLInputElement).disabled = true;
      });
    }) as EventListener);
    listen(window, 'reach-interactive-resume', (() => {
      if (failed || disposed) return;
      suspended = false;
      root.querySelectorAll('button,input,select').forEach((element) => {
        (element as HTMLInputElement).disabled = false;
      });
      resize();
    }) as EventListener);
    cleanups.push(finish);
    resize();
    paint();
  } catch (error) {
    failure();
    cleanups.forEach((cleanup) => cleanup());
    view?.dispose();
    session?.dispose();
    engine?.dispose();
    throw error;
  }
  const controller: GeometryScienceKitController = Object.freeze({
    reset: () => {
      if (!disposed) {
        pending = undefined;
        session!.reset();
        schedule();
      }
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      pending = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      cleanups.forEach((cleanup) => cleanup());
      view!.dispose();
      session!.dispose();
      target.replaceChildren();
    },
    getState: () => session!.getState(),
    setState: (state: unknown) => {
      if (disposed) return false;
      pending = undefined;
      const result = session!.setState(state);
      if (result.ok) schedule();
      return result.ok;
    },
    getComputedState: () => session!.getComputedState(),
    applyCommand: (command: unknown) => apply(command, 'api'),
  });
  return controller;
}

export function geometryMount(factory: GeometryViewFactory): ScienceKitMount {
  return (
    target: HTMLElement,
    _spec: Readonly<Record<string, unknown>>,
    context?: GeometryMountContext,
  ) => {
    if (!context) throw new Error('Geometry mount context is required');
    return mountGeometry(target, context, factory);
  };
}
