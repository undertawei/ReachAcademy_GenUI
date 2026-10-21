import {
  createElement,
  BetweenHorizontalStart,
  CircleDot,
  CornerDownRight,
  Eraser,
  EyeOff,
  Gauge,
  GitCompareArrows,
  Minus,
  MousePointer2,
  MoveRight,
  Redo2,
  RotateCcw,
  Ruler,
  Search,
  Slash,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide';
import {
  geometryObjectOutputType,
  type GeometryCamera,
  type GeometryFreedom,
  type GeometryObject,
  type GeometryRange,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  geometryAuthoringExplorationPolicyV2,
  parseGeometryEnvelopeV2,
  type GeometryAuxiliaryMeasurementKindV2,
  type GeometryAuxiliaryObjectKindV2,
  type GeometryAuxiliaryStateV2,
  type GeometryEnvelopeV2,
  type GeometryRelationV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import {
  createGeometrySessionV2,
  type GeometryComputedStateV2,
  type GeometrySessionCommandV2,
  type GeometrySessionResultV2,
  type GeometrySessionStateV2,
  type GeometrySessionV2,
} from '@reachany/reach-deck-geometry/session-v2';
import type { ScienceKitController, ScienceKitMount } from './science-kit-runtime.shared';
import { proposeFreedom, zoomGeometryCamera } from './geometry-interaction';
import type { GeometryPixelV2, GeometryViewV2, GeometryWorldV2 } from './geometry-spatial-v2';

export type GeometryHostModeV2 = 'learner' | 'authoring-edit' | 'authoring-trial';

export interface GeometryMountContextV2 {
  readonly instanceId: string;
  readonly envelope: unknown;
  readonly locale: string;
  readonly messages: Readonly<Record<string, string>>;
  readonly geometryHostMode: GeometryHostModeV2;
  readonly pageId: string;
  readonly sourceRevision: number;
  readonly authoredSnapshot?: Readonly<{
    schemaVersion: 'reach-geometry-authored-snapshot/v1';
    instanceId: string;
    fingerprint: string;
    inputs: GeometrySessionStateV2['inputs'];
    camera: GeometrySessionStateV2['camera'];
  }>;
  readonly canAdoptState?: (candidate: GeometrySessionStateV2) => boolean;
  readonly onStateChange?: () => boolean;
}

export interface GeometryScienceKitControllerV2 extends ScienceKitController {
  getState(): GeometrySessionStateV2;
  getComputedState(): GeometryComputedStateV2;
  applyCommand(command: unknown): GeometrySessionResultV2;
}

export type GeometryViewFactoryV2 = (
  scene: HTMLElement,
  envelope: GeometryEnvelopeV2,
  fail: () => void,
) => GeometryViewV2;

type ObjectRole = 'point' | 'linear' | 'segment' | 'plane';
type GeometryTool = {
  key: string;
  category: 'object' | 'measurement' | 'relation';
  kind:
    | GeometryAuxiliaryObjectKindV2
    | GeometryAuxiliaryMeasurementKindV2
    | GeometryRelationV2['kind'];
  operands: readonly ObjectRole[];
  icon: Parameters<typeof createElement>[0];
};

const prefix = 'reachDeck.geometry.';
const commandVersion = 'reach-geometry-command/v2';
const emptyAuxiliary = (): GeometryAuxiliaryStateV2 => ({
  objects: [],
  measurements: [],
  relations: [],
  freedoms: [],
  presentation: { objects: [], measurements: [], relations: [] },
});

const tools: readonly GeometryTool[] = [
  {
    key: 'tool.segment',
    category: 'object',
    kind: 'segment',
    operands: ['point', 'point'],
    icon: Minus,
  },
  { key: 'tool.line', category: 'object', kind: 'line', operands: ['point', 'point'], icon: Slash },
  {
    key: 'tool.midpoint',
    category: 'object',
    kind: 'midpoint',
    operands: ['point', 'point'],
    icon: BetweenHorizontalStart,
  },
  {
    key: 'tool.pointOnLine',
    category: 'object',
    kind: 'pointOnLine',
    operands: ['linear'],
    icon: CircleDot,
  },
  {
    key: 'tool.parallelLine',
    category: 'object',
    kind: 'parallelLine',
    operands: ['point', 'linear'],
    icon: GitCompareArrows,
  },
  {
    key: 'tool.footToLine',
    category: 'object',
    kind: 'footToLine',
    operands: ['point', 'linear'],
    icon: CornerDownRight,
  },
  {
    key: 'tool.footToPlane',
    category: 'object',
    kind: 'footToPlane',
    operands: ['point', 'plane'],
    icon: CornerDownRight,
  },
  {
    key: 'tool.distance',
    category: 'measurement',
    kind: 'distance',
    operands: ['point', 'point'],
    icon: Ruler,
  },
  {
    key: 'tool.segmentLength',
    category: 'measurement',
    kind: 'distance',
    operands: ['segment'],
    icon: Ruler,
  },
  {
    key: 'tool.pointLineDistance',
    category: 'measurement',
    kind: 'pointLineDistance',
    operands: ['point', 'linear'],
    icon: Gauge,
  },
  {
    key: 'tool.pointSegmentDistance',
    category: 'measurement',
    kind: 'pointSegmentDistance',
    operands: ['point', 'segment'],
    icon: Gauge,
  },
  {
    key: 'tool.pointPlaneDistance',
    category: 'measurement',
    kind: 'pointPlaneDistance',
    operands: ['point', 'plane'],
    icon: Gauge,
  },
  {
    key: 'tool.lineAngle',
    category: 'measurement',
    kind: 'lineAngle',
    operands: ['linear', 'linear'],
    icon: MoveRight,
  },
  {
    key: 'tool.linePlaneAngle',
    category: 'measurement',
    kind: 'linePlaneAngle',
    operands: ['linear', 'plane'],
    icon: MoveRight,
  },
  {
    key: 'tool.lineLineRelation',
    category: 'relation',
    kind: 'lineLine',
    operands: ['linear', 'linear'],
    icon: Search,
  },
  {
    key: 'tool.linePlaneRelation',
    category: 'relation',
    kind: 'linePlane',
    operands: ['linear', 'plane'],
    icon: Search,
  },
];

const measurementLabelKeys = {
  distance: 'tool.distance',
  pointLineDistance: 'tool.pointLineDistance',
  pointSegmentDistance: 'tool.pointSegmentDistance',
  pointPlaneDistance: 'tool.pointPlaneDistance',
  lineAngle: 'tool.lineAngle',
  linePlaneAngle: 'tool.linePlaneAngle',
} as const satisfies Record<GeometryAuxiliaryMeasurementKindV2, string>;

const relationLabelKeys = {
  lineLine: 'tool.lineLineRelation',
  linePlane: 'tool.linePlaneRelation',
} as const satisfies Record<GeometryRelationV2['kind'], string>;

const css = `
.reach-geometry-v2{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;position:relative;overflow:hidden;background:#fff;color:#172033;font:13px/1.4 system-ui,sans-serif;letter-spacing:0;container-type:inline-size}
.reach-geometry-v2 *{box-sizing:border-box;letter-spacing:0}
.reach-geometry-v2 button{display:inline-flex;align-items:center;justify-content:center;flex:0 0 34px;width:34px;height:34px;padding:7px;background:#fff;border:1px solid #cbd2db;border-radius:4px;color:#334155;cursor:pointer}
.reach-geometry-v2 button:hover,.reach-geometry-v2 button[aria-pressed=true]{background:#e4f2ef;border-color:#087e8b;color:#075f69}.reach-geometry-v2 button:disabled{opacity:.45;cursor:default}
.reach-geometry-v2 button svg{width:18px;height:18px;flex:none}.reach-geometry-v2 button:focus-visible,.reach-geometry-v2 input:focus-visible,.reach-geometry-v2 select:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.reach-geometry-v2__toolbar{display:flex;flex:none;align-items:center;gap:5px;padding:6px 8px;border-bottom:1px solid #dce1e6;min-height:46px;overflow-x:auto}
.reach-geometry-v2__divider{height:24px;width:1px;flex:none;background:#dce1e6;margin:0 2px}
.reach-geometry-v2__scene{position:relative;flex:1 1 auto;min-height:140px;min-width:0;overflow:hidden;touch-action:none;background:#f8fafc;outline-offset:-3px}
.reach-geometry-v2__scene canvas,.reach-geometry-v2__scene svg{display:block;width:100%;height:100%}
.reach-geometry-v2__status{display:flex;align-items:center;gap:8px;min-height:34px;padding:5px 8px;border-top:1px solid #dce1e6;background:#fff;overflow-x:auto}
.reach-geometry-v2__status span{white-space:nowrap}.reach-geometry-v2__status select{height:28px;min-width:120px;max-width:220px;border:1px solid #cbd2db;border-radius:3px;background:#fff;color:inherit}
.reach-geometry-v2__panels{display:grid;grid-template-columns:minmax(150px,1fr) minmax(180px,1.35fr);flex:none;max-height:31%;border-top:1px solid #dce1e6;background:#fff}
.reach-geometry-v2__panel{min-width:0;overflow:auto;padding:7px 9px}.reach-geometry-v2__panel+ .reach-geometry-v2__panel{border-left:1px solid #e2e8f0}
.reach-geometry-v2__panel h3{font-size:11px;font-weight:600;color:#526174;margin:0 0 5px}.reach-geometry-v2__row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-height:24px}.reach-geometry-v2__row output{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.reach-geometry-v2__inputs{display:flex;flex-wrap:wrap;gap:6px 10px}.reach-geometry-v2__field{display:flex;align-items:center;gap:5px}.reach-geometry-v2__field input{width:74px;height:28px;border:1px solid #cbd2db;border-radius:3px;padding:3px 5px}
.reach-geometry-v2__confirmation{position:absolute;inset:0;z-index:4;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.42)}.reach-geometry-v2__confirmation[hidden]{display:none}.reach-geometry-v2__confirmation-panel{width:min(360px,100%);padding:16px;background:#fff;border:1px solid #cbd2db;border-radius:6px;box-shadow:0 12px 30px rgba(15,23,42,.24)}.reach-geometry-v2__confirmation-message{margin:0;white-space:pre-wrap}.reach-geometry-v2__confirmation-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.reach-geometry-v2__confirmation .reach-geometry-v2__confirmation-button{flex:0 1 auto;width:auto;min-width:72px;padding:6px 12px}.reach-geometry-v2__confirmation .reach-geometry-v2__confirmation-button--primary{background:#087e8b;border-color:#087e8b;color:#fff}
.reach-geometry-v2__error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;color:#9f1239;padding:20px;text-align:center}
@container(max-width:520px){.reach-geometry-v2__toolbar{padding:4px}.reach-geometry-v2__panels{grid-template-columns:1fr;max-height:38%}.reach-geometry-v2__panel+ .reach-geometry-v2__panel{border-left:0;border-top:1px solid #e2e8f0}.reach-geometry-v2__status{flex-wrap:wrap}}
`;

const roleFor = (object: GeometryObject): ObjectRole | undefined => {
  if (object.kind === 'segment') return 'segment';
  const output = geometryObjectOutputType(object.kind);
  return output === 'point' || output === 'linear' || output === 'plane' ? output : undefined;
};

const roleMatches = (actual: ObjectRole | undefined, expected: ObjectRole): boolean =>
  expected === 'linear' ? actual === 'linear' || actual === 'segment' : actual === expected;

export const geometryRelationMessageKeyV2 = (
  relation: GeometryComputedStateV2['relations'][string],
): string => {
  if (relation.status !== 'valid') return 'undefined';
  if (
    relation.kind === 'lineLine' &&
    relation.classification === 'intersecting' &&
    !relation.intersectsDeclaredDomains
  )
    return 'relation.intersectionOutsideLineDomains';
  if (
    relation.kind === 'linePlane' &&
    relation.classification === 'intersecting' &&
    !relation.intersectsDeclaredDomain
  )
    return 'relation.intersectionOutsideLineDomain';
  return `relation.${relation.classification}`;
};

export const geometryPointOnLineRangeV2 = (kind: GeometryObject['kind']): GeometryRange =>
  kind === 'segment'
    ? { min: 0, max: 1, step: 0.05 }
    : kind === 'ray'
      ? { min: 0, max: 10, step: 0.05 }
      : { min: -10, max: 10, step: 0.05 };

const distanceToSegment = (
  point: GeometryPixelV2,
  start: GeometryPixelV2,
  end: GeometryPixelV2,
): number => {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length),
        );
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
};

export function createPlanarViewV2(
  scene: HTMLElement,
  envelope: GeometryEnvelopeV2,
): GeometryViewV2 {
  const document = scene.ownerDocument;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  scene.append(svg);
  let width = 1;
  let height = 1;
  let state: GeometryComputedStateV2 | undefined;
  const definitions = () =>
    new Map([
      ...envelope.spec.objects.map((object) => [object.id, object] as const),
      ...(state?.auxiliary.objects ?? []).map((object) => [object.id, object] as const),
    ]);
  const presentations = () =>
    new Map([
      ...envelope.spec.presentation.objects.map((entry) => [entry.object, entry] as const),
      ...(state?.auxiliary.presentation.objects ?? []).map(
        (entry) => [entry.object, entry] as const,
      ),
    ]);
  const camera = () => state!.camera as Extract<GeometryCamera, { kind: 'planar' }>;
  const project = (point: GeometryWorldV2): GeometryPixelV2 | null => {
    if (!state || point.length < 2 || !point.every(Number.isFinite)) return null;
    const [left, bottom, right, top] = camera().bounds;
    return [
      ((point[0] - left) / (right - left)) * width,
      ((top - point[1]) / (top - bottom)) * height,
    ];
  };
  const unproject = (pixel: GeometryPixelV2): GeometryWorldV2 | null => {
    if (!state || !pixel.every(Number.isFinite)) return null;
    const [left, bottom, right, top] = camera().bounds;
    return [left + (pixel[0] / width) * (right - left), top - (pixel[1] / height) * (top - bottom)];
  };
  const visible = (id: string): boolean => {
    if (!state || state.hiddenAuxiliary.includes(id)) return false;
    const style = presentations().get(id);
    if (style?.visible === false) return false;
    const owners = envelope.spec.presentation.groups.filter((group) => group.objects.includes(id));
    return owners.length === 0 || owners.some((group) => state!.visibleGroups.includes(group.id));
  };
  const color = (id: string) =>
    ({
      ink: '#243447',
      muted: '#718096',
      accent: '#087e8b',
      success: '#16866d',
      warning: '#ae6a19',
    })[presentations().get(id)?.colorToken ?? 'ink'];
  const render = () => {
    if (!state) return;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    for (const [id, object] of Object.entries(state.objects)) {
      if (!visible(id) || object.status !== 'valid') continue;
      const style = presentations().get(id);
      if (object.coordinates && object.radius === undefined) {
        const point = project(object.coordinates);
        if (!point) continue;
        const circle = document.createElementNS(svg.namespaceURI, 'circle');
        circle.setAttribute('cx', String(point[0]));
        circle.setAttribute('cy', String(point[1]));
        circle.setAttribute('r', state.selection === id ? '6' : '4.5');
        circle.setAttribute('fill', color(id));
        circle.setAttribute('data-geometry-object', id);
        svg.append(circle);
      } else if (object.origin && object.direction) {
        const definition = definitions().get(id);
        const domain =
          definition?.kind === 'segment' ? 'segment' : definition?.kind === 'ray' ? 'ray' : 'line';
        const [left, bottom, right, top] = camera().bounds;
        const span = Math.hypot(right - left, top - bottom) * 2;
        const magnitude = Math.hypot(object.direction[0], object.direction[1]);
        if (!(magnitude > 0)) continue;
        const unit = object.direction.map((value) => value / magnitude);
        const a =
          domain === 'line'
            ? object.origin.map((value, index) => value - unit[index] * span)
            : object.origin;
        const b =
          domain === 'segment'
            ? object.origin.map((value, index) => value + object.direction![index])
            : object.origin.map((value, index) => value + unit[index] * span);
        const start = project(a),
          end = project(b);
        if (!start || !end) continue;
        const line = document.createElementNS(svg.namespaceURI, 'line');
        line.setAttribute('x1', String(start[0]));
        line.setAttribute('y1', String(start[1]));
        line.setAttribute('x2', String(end[0]));
        line.setAttribute('y2', String(end[1]));
        line.setAttribute('stroke', color(id));
        line.setAttribute('stroke-width', state.selection === id ? '3' : '2');
        if (style?.lineStyle === 'dashed') line.setAttribute('stroke-dasharray', '8 5');
        if (style?.lineStyle === 'dotted') line.setAttribute('stroke-dasharray', '2 5');
        line.setAttribute('data-geometry-object', id);
        svg.append(line);
      }
      const label = style?.label;
      if (label) {
        const anchor = object.coordinates ?? object.origin;
        const point = anchor ? project(anchor) : null;
        if (point) {
          const text = document.createElementNS(svg.namespaceURI, 'text');
          text.setAttribute('x', String(Math.max(4, Math.min(width - 24, point[0] + 8))));
          text.setAttribute('y', String(Math.max(16, Math.min(height - 4, point[1] - 7))));
          text.setAttribute('fill', color(id));
          text.setAttribute('font-size', '13');
          text.setAttribute('font-weight', '600');
          text.textContent = label;
          svg.append(text);
        }
      }
    }
  };
  const pickCandidates = (pixel: GeometryPixelV2, pointerType: 'mouse' | 'touch') => {
    if (!state) return [];
    const threshold = pointerType === 'touch' ? 18 : 10;
    const hits: { id: string; distance: number; priority: number }[] = [];
    for (const [id, object] of Object.entries(state.objects)) {
      if (!visible(id) || object.status !== 'valid') continue;
      if (object.coordinates && object.radius === undefined) {
        const point = project(object.coordinates);
        if (point)
          hits.push({
            id,
            distance: Math.hypot(point[0] - pixel[0], point[1] - pixel[1]),
            priority: 0,
          });
      } else if (object.origin && object.direction) {
        const start = project(object.origin);
        const end = project(object.origin.map((value, index) => value + object.direction![index]));
        if (start && end)
          hits.push({ id, distance: distanceToSegment(pixel, start, end), priority: 1 });
      }
    }
    return hits
      .filter((hit) => hit.distance <= threshold)
      .sort(
        (a, b) => a.priority - b.priority || a.distance - b.distance || a.id.localeCompare(b.id),
      )
      .map((hit) => hit.id);
  };
  return {
    paint(next) {
      state = next;
      render();
    },
    rebuild(next) {
      state = next;
      render();
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      render();
    },
    pickCandidates,
    project,
    dragPoint: (pixel) => unproject(pixel),
    orbit: (next) => next,
    dispose: () => svg.remove(),
  };
}

export function mountGeometryV2(
  target: HTMLElement,
  context: GeometryMountContextV2,
  factory: GeometryViewFactoryV2,
): GeometryScienceKitControllerV2 {
  const parsed = parseGeometryEnvelopeV2(context.envelope);
  const envelope = parsed.envelope;
  const spec = envelope.spec;
  const authoringExploration =
    context.geometryHostMode === 'authoring-edit' && spec.authoring !== undefined
      ? geometryAuthoringExplorationPolicyV2(parsed)
      : undefined;
  const explorationPolicy = authoringExploration ?? spec.interaction.exploration;
  const t = (key: string): string => {
    const message = context.messages[prefix + key];
    if (typeof message !== 'string') throw new Error(`Missing geometry message: ${key}`);
    return message;
  };
  const document = target.ownerDocument;
  target.replaceChildren();
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  root.className = 'reach-geometry-v2';
  root.dataset.geometryInstance = context.instanceId;
  root.dataset.geometryHostMode = context.geometryHostMode;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', spec.ariaLabel);
  const toolbar = document.createElement('div');
  toolbar.className = 'reach-geometry-v2__toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', t('controls'));
  const scene = document.createElement('div');
  scene.className = 'reach-geometry-v2__scene';
  scene.dataset.geometrySurface = '';
  scene.tabIndex = 0;
  scene.setAttribute('role', 'application');
  scene.setAttribute('aria-label', spec.ariaLabel);
  const status = document.createElement('div');
  status.className = 'reach-geometry-v2__status';
  status.setAttribute('aria-live', 'polite');
  const instruction = document.createElement('span');
  const candidatePicker = document.createElement('select');
  candidatePicker.hidden = true;
  candidatePicker.setAttribute('aria-label', t('chooseCandidate'));
  const selectionLabel = document.createElement('label');
  selectionLabel.textContent = t('selectedItem');
  const selection = document.createElement('select');
  selection.dataset.geometrySelection = '';
  selection.setAttribute('aria-label', t('selectedItem'));
  selectionLabel.append(' ', selection);
  status.append(instruction, candidatePicker, selectionLabel);
  const panels = document.createElement('div');
  panels.className = 'reach-geometry-v2__panels';
  const inputsPanel = document.createElement('section');
  inputsPanel.className = 'reach-geometry-v2__panel';
  const inputsTitle = document.createElement('h3');
  inputsTitle.textContent = t('parameters');
  const inputs = document.createElement('div');
  inputs.className = 'reach-geometry-v2__inputs';
  inputsPanel.append(inputsTitle, inputs);
  const readingsPanel = document.createElement('section');
  readingsPanel.className = 'reach-geometry-v2__panel';
  const readingsTitle = document.createElement('h3');
  readingsTitle.textContent = t('measurements');
  const readings = document.createElement('div');
  readingsPanel.append(readingsTitle, readings);
  panels.append(inputsPanel, readingsPanel);
  const confirmation = document.createElement('div');
  confirmation.className = 'reach-geometry-v2__confirmation';
  confirmation.dataset.geometryConfirmation = '';
  confirmation.hidden = true;
  confirmation.setAttribute('role', 'alertdialog');
  confirmation.setAttribute('aria-modal', 'true');
  const confirmationPanel = document.createElement('div');
  confirmationPanel.className = 'reach-geometry-v2__confirmation-panel';
  const confirmationMessage = document.createElement('p');
  confirmationMessage.className = 'reach-geometry-v2__confirmation-message';
  confirmationMessage.id = `reach-geometry-confirmation-${context.instanceId}`;
  confirmation.setAttribute('aria-describedby', confirmationMessage.id);
  const confirmationActions = document.createElement('div');
  confirmationActions.className = 'reach-geometry-v2__confirmation-actions';
  const confirmationCancel = document.createElement('button');
  confirmationCancel.type = 'button';
  confirmationCancel.className = 'reach-geometry-v2__confirmation-button';
  confirmationCancel.dataset.geometryConfirmationCancel = '';
  confirmationCancel.textContent = t('cancel');
  const confirmationAccept = document.createElement('button');
  confirmationAccept.type = 'button';
  confirmationAccept.className =
    'reach-geometry-v2__confirmation-button reach-geometry-v2__confirmation-button--primary';
  confirmationAccept.dataset.geometryConfirmationAccept = '';
  confirmationAccept.textContent = t('confirm');
  confirmationActions.append(confirmationCancel, confirmationAccept);
  confirmationPanel.append(confirmationMessage, confirmationActions);
  confirmation.append(confirmationPanel);
  root.append(toolbar, scene, status, panels, confirmation);
  target.append(style, root);

  let disposed = false,
    suspended = false,
    failed = false,
    frame: number | undefined;
  let session: GeometrySessionV2 | undefined,
    view: GeometryViewV2 | undefined,
    renderedModelRevision = -1;
  let activeTool: GeometryTool | undefined,
    operands: string[] = [],
    activeItem: string | null = null,
    revealedGeometryRevision: number | undefined;
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
  let confirmationAction: (() => void) | undefined;
  let confirmationReturnFocus: HTMLElement | undefined;
  const closeConfirmation = () => {
    confirmation.hidden = true;
    confirmationAction = undefined;
    confirmationReturnFocus?.focus();
    confirmationReturnFocus = undefined;
  };
  const requestConfirmation = (message: string, action: () => void) => {
    confirmationMessage.textContent = message;
    confirmationAction = action;
    confirmationReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    confirmation.hidden = false;
    confirmationAccept.focus();
  };
  listen(confirmationCancel, 'click', closeConfirmation);
  listen(confirmationAccept, 'click', () => {
    const action = confirmationAction;
    closeConfirmation();
    action?.();
  });
  listen(confirmation, 'keydown', ((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeConfirmation();
  }) as EventListener);
  const fail = () => {
    if (failed || disposed) return;
    failed = true;
    root
      .querySelectorAll('button,input,select')
      .forEach((node) => ((node as HTMLInputElement).disabled = true));
    const error = document.createElement('div');
    error.className = 'reach-geometry-v2__error';
    error.setAttribute('role', 'alert');
    error.textContent = t('rendererUnavailable');
    scene.append(error);
    (
      window as unknown as { ReachInteractive?: { error(value: unknown): void } }
    ).ReachInteractive?.error({ code: 'geometry_renderer_unavailable' });
  };
  const objectDefinitions = (state: GeometryComputedStateV2) =>
    new Map([
      ...spec.objects.map((object) => [object.id, object] as const),
      ...state.auxiliary.objects.map((object) => [object.id, object] as const),
    ]);
  const labels = (state: GeometryComputedStateV2) =>
    new Map([
      ...spec.presentation.objects.map(
        (entry) => [entry.object, entry.label ?? entry.object] as const,
      ),
      ...state.auxiliary.presentation.objects.map(
        (entry) => [entry.object, entry.label ?? entry.object] as const,
      ),
    ]);
  const format = (value: number, decimals: number) =>
    new Intl.NumberFormat(context.locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      ...(Math.abs(value) >= 1e9 ? { notation: 'scientific' as const } : {}),
    }).format(value);
  const allIds = (state: GeometrySessionStateV2) =>
    new Set([
      ...spec.parameters.map((entry) => entry.id),
      ...spec.objects.map((entry) => entry.id),
      ...spec.measurements.map((entry) => entry.id),
      ...spec.relations.map((entry) => entry.id),
      ...spec.interaction.freedoms.map((entry) => entry.id),
      ...state.auxiliary.objects.map((entry) => entry.id),
      ...state.auxiliary.measurements.map((entry) => entry.id),
      ...state.auxiliary.relations.map((entry) => entry.id),
      ...state.auxiliary.freedoms.map((entry) => entry.id),
    ]);
  const nextId = (stem: string, state: GeometrySessionStateV2) => {
    const ids = allIds(state);
    let index = 1;
    while (ids.has(`L_${stem}${index}`)) index += 1;
    return `L_${stem}${index}`;
  };
  const isToolAllowed = (tool: GeometryTool) => {
    const policy = explorationPolicy;
    if (tool.category === 'object')
      return policy.objectKinds.includes(tool.kind as GeometryAuxiliaryObjectKindV2);
    if (tool.category === 'measurement')
      return policy.measurementKinds.includes(tool.kind as GeometryAuxiliaryMeasurementKindV2);
    return policy.relationKinds.includes(tool.kind as GeometryRelationV2['kind']);
  };
  const referenceable = (id: string, role: ObjectRole, state: GeometryComputedStateV2) => {
    if (state.hiddenAuxiliary.includes(id) || state.objects[id]?.status !== 'valid') return false;
    const object = objectDefinitions(state).get(id);
    if (!object || !roleMatches(roleFor(object), role)) return false;
    return id.startsWith('L_') || explorationPolicy.referenceableObjects.includes(id);
  };
  const announce = () => {
    candidatePicker.hidden = true;
    candidatePicker.replaceChildren();
    instruction.textContent = activeTool
      ? `${t(activeTool.key)}: ${operands.length}/${activeTool.operands.length}`
      : t('selectTool');
  };
  const cancelTool = () => {
    activeTool = undefined;
    operands = [];
    for (const button of toolbar.querySelectorAll('[data-geometry-tool]'))
      button.setAttribute('aria-pressed', 'false');
    announce();
  };
  const additionFor = (
    tool: GeometryTool,
    chosen: readonly string[],
    state: GeometrySessionStateV2,
  ): GeometryAuxiliaryStateV2 => {
    const addition = emptyAuxiliary();
    if (tool.category === 'object') {
      const id = nextId('O', state);
      const objects: GeometryAuxiliaryStateV2['objects'][number][] = [];
      if (tool.kind === 'line' || tool.kind === 'segment' || tool.kind === 'midpoint')
        objects.push({ id, kind: tool.kind, a: chosen[0]!, b: chosen[1]! });
      else if (tool.kind === 'pointOnLine')
        objects.push({ id, kind: 'pointOnLine', line: chosen[0]!, t: 0.5 });
      else if (tool.kind === 'parallelLine')
        objects.push({ id, kind: 'parallelLine', point: chosen[0]!, line: chosen[1]! });
      else if (tool.kind === 'footToLine')
        objects.push({ id, kind: 'footToLine', point: chosen[0]!, line: chosen[1]! });
      else if (tool.kind === 'footToPlane')
        objects.push({ id, kind: 'footToPlane', point: chosen[0]!, plane: chosen[1]! });
      const freedoms: GeometryFreedom[] =
        tool.kind === 'pointOnLine'
          ? [
              {
                id: nextId('F', {
                  ...state,
                  auxiliary: {
                    ...state.auxiliary,
                    objects: [...state.auxiliary.objects, ...objects],
                  },
                }),
                kind: 'line',
                object: id,
                range: geometryPointOnLineRangeV2(
                  objectDefinitions(session!.getComputedState()).get(chosen[0]!)!.kind,
                ),
              },
            ]
          : [];
      if (
        (tool.kind === 'footToLine' || tool.kind === 'footToPlane') &&
        explorationPolicy.objectKinds.includes('segment')
      ) {
        const segmentId = nextId('O', {
          ...state,
          auxiliary: {
            ...state.auxiliary,
            objects: [...state.auxiliary.objects, ...objects],
          },
        });
        objects.push({ id: segmentId, kind: 'segment', a: chosen[0]!, b: id });
      }
      return {
        ...addition,
        objects,
        freedoms,
        presentation: {
          ...addition.presentation,
          objects: objects
            .map((object, index) => ({
              object: object.id,
              ...(index === 0 && geometryObjectOutputType(object.kind) === 'point'
                ? { label: object.id.replace('L_O', 'P') }
                : {}),
              colorToken: 'accent' as const,
              lineStyle: index > 0 ? ('dashed' as const) : undefined,
            }))
            .map(({ lineStyle, ...entry }) =>
              lineStyle === undefined ? entry : { ...entry, lineStyle },
            ),
        },
      };
    }
    if (tool.category === 'measurement') {
      const id = nextId('M', state);
      const definition = objectDefinitions(session!.getComputedState()).get(chosen[0]!);
      const measurement =
        tool.key === 'tool.segmentLength' && definition && 'a' in definition && 'b' in definition
          ? { id, kind: 'distance' as const, a: definition.a, b: definition.b }
          : tool.kind === 'distance'
            ? { id, kind: 'distance' as const, a: chosen[0]!, b: chosen[1]! }
            : tool.kind === 'pointLineDistance'
              ? { id, kind: 'pointLineDistance' as const, point: chosen[0]!, line: chosen[1]! }
              : tool.kind === 'pointSegmentDistance'
                ? {
                    id,
                    kind: 'pointSegmentDistance' as const,
                    point: chosen[0]!,
                    segment: chosen[1]!,
                  }
                : tool.kind === 'pointPlaneDistance'
                  ? {
                      id,
                      kind: 'pointPlaneDistance' as const,
                      point: chosen[0]!,
                      plane: chosen[1]!,
                    }
                  : tool.kind === 'lineAngle'
                    ? { id, kind: 'lineAngle' as const, line1: chosen[0]!, line2: chosen[1]! }
                    : { id, kind: 'linePlaneAngle' as const, line: chosen[0]!, plane: chosen[1]! };
      return {
        ...addition,
        measurements: [measurement],
        presentation: {
          ...addition.presentation,
          measurements: [
            {
              measurement: id,
              decimals:
                measurement.kind.includes('Angle') || measurement.kind === 'lineAngle' ? 1 : 2,
            },
          ],
        },
      };
    }
    const id = nextId('R', state);
    const relation: GeometryRelationV2 =
      tool.kind === 'lineLine'
        ? { id, kind: 'lineLine', line1: chosen[0]!, line2: chosen[1]! }
        : { id, kind: 'linePlane', line: chosen[0]!, plane: chosen[1]! };
    return {
      ...addition,
      relations: [relation],
      presentation: {
        ...addition.presentation,
        relations: [{ relation: id, visible: true }],
      },
    };
  };
  const preview = (
    command: unknown,
  ): { result: GeometrySessionResultV2; state?: GeometrySessionStateV2 } => {
    const candidate = createGeometrySessionV2(envelope, context.instanceId, {
      ...(authoringExploration === undefined ? {} : { explorationPolicy: authoringExploration }),
    });
    try {
      const restored = candidate.setState(session!.getState());
      if (!restored.ok) return { result: restored };
      const result = candidate.applyCommand(command);
      return result.ok ? { result, state: candidate.getState() } : { result };
    } finally {
      candidate.dispose();
    }
  };
  const dispatch = (result: GeometrySessionResultV2, source: 'control' | 'api') => {
    if (!result.ok || !result.changed || !result.change) return;
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
    context.onStateChange?.();
  };
  const apply = (command: unknown, source: 'control' | 'api'): GeometrySessionResultV2 => {
    if (!session || disposed || failed) return { ok: false, code: 'disposed' };
    const candidate = preview(command);
    if (!candidate.result.ok || !candidate.state) return candidate.result;
    if (context.canAdoptState && !context.canAdoptState(candidate.state))
      return { ok: false, code: 'state_bytes_exceeded' };
    const result = session.applyCommand(command);
    dispatch(result, source);
    if (result.ok && result.changed) schedule();
    return result;
  };
  const control = (command: GeometrySessionCommandV2, historyGroup?: string) =>
    apply(
      { schemaVersion: commandVersion, ...command, ...(historyGroup ? { historyGroup } : {}) },
      'control',
    );
  const createFromOperands = () => {
    if (!activeTool || operands.length !== activeTool.operands.length) return;
    const addition = additionFor(activeTool, operands, session!.getState());
    const result = control({ kind: 'addAuxiliary', auxiliary: addition });
    if (!result.ok)
      instruction.textContent =
        context.messages[`${prefix}error.${result.code}`] ?? t('invalidInput');
    else {
      activeItem =
        addition.objects[0]?.id ??
        addition.measurements[0]?.id ??
        addition.relations[0]?.id ??
        null;
      cancelTool();
    }
  };
  const choose = (id: string) => {
    const state = session!.getComputedState();
    if (!activeTool) {
      activeItem = id;
      if (objectDefinitions(state).has(id)) control({ kind: 'select', objectId: id });
      schedule();
      return;
    }
    const expected = activeTool.operands[operands.length];
    if (!expected || operands.includes(id) || !referenceable(id, expected, state)) return;
    operands.push(id);
    announce();
    createFromOperands();
  };
  const presentCandidates = (ids: readonly string[]) => {
    const state = session!.getComputedState();
    const expected = activeTool?.operands[operands.length];
    const filtered = ids.filter((id) =>
      expected
        ? referenceable(id, expected, state) && !operands.includes(id)
        : objectDefinitions(state).has(id),
    );
    if (filtered.length === 1) choose(filtered[0]!);
    else if (filtered.length > 1) {
      candidatePicker.replaceChildren(
        ...filtered.map((id) => {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = labels(state).get(id) ?? id;
          return option;
        }),
      );
      candidatePicker.hidden = false;
      candidatePicker.selectedIndex = -1;
      candidatePicker.focus();
    }
  };
  const paint = () => {
    if (!session || !view || disposed || suspended || failed) return;
    const state = session.getComputedState();
    if (state.modelRevision !== renderedModelRevision) {
      renderedModelRevision = state.modelRevision;
      view.rebuild(state);
    } else view.paint(state);
    const objectLabels = labels(state);
    const previous = selection.value;
    selection.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('none');
    selection.append(none);
    for (const [id, object] of objectDefinitions(state)) {
      if (state.objects[id]?.status !== 'valid') continue;
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${objectLabels.get(id) ?? id}${
        state.hiddenAuxiliary.includes(id) ? ` (${t('hiddenItem')})` : ''
      }`;
      option.dataset.hidden = String(state.hiddenAuxiliary.includes(id));
      selection.append(option);
    }
    const auxiliaryMeasurements = new Map(
      state.auxiliary.measurements.map((entry) => [entry.id, entry] as const),
    );
    const auxiliaryRelations = new Map(
      state.auxiliary.relations.map((entry) => [entry.id, entry] as const),
    );
    const auxiliaryReadingLabels = new Map([
      ...state.auxiliary.presentation.measurements.map(
        (entry) =>
          [
            entry.measurement,
            entry.label ??
              (auxiliaryMeasurements.has(entry.measurement)
                ? t(measurementLabelKeys[auxiliaryMeasurements.get(entry.measurement)!.kind])
                : entry.measurement),
          ] as const,
      ),
      ...state.auxiliary.presentation.relations.map(
        (entry) =>
          [
            entry.relation,
            entry.label ??
              (auxiliaryRelations.has(entry.relation)
                ? t(relationLabelKeys[auxiliaryRelations.get(entry.relation)!.kind])
                : entry.relation),
          ] as const,
      ),
    ]);
    for (const id of [
      ...state.auxiliary.measurements.map((entry) => entry.id),
      ...state.auxiliary.relations.map((entry) => entry.id),
    ]) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${auxiliaryReadingLabels.get(id) ?? id}${
        state.hiddenAuxiliary.includes(id) ? ` (${t('hiddenItem')})` : ''
      }`;
      option.dataset.hidden = String(state.hiddenAuxiliary.includes(id));
      selection.append(option);
    }
    const activeSelection =
      activeItem !== null &&
      Array.from(selection.options).some((option) => option.value === activeItem)
        ? activeItem
        : state.selection;
    selection.value =
      activeSelection ??
      (Array.from(selection.options).some((option) => option.value === previous) ? previous : '');
    readings.replaceChildren();
    const auxiliaryFeedbackVisible =
      spec.interaction.exploration.feedback === 'immediate' ||
      (spec.interaction.exploration.feedback === 'onRequest' &&
        revealedGeometryRevision === state.geometryRevision);
    const measurementPresentation = [
      ...spec.presentation.measurements,
      ...state.auxiliary.presentation.measurements,
    ];
    for (const item of measurementPresentation) {
      if (item.visible === false || state.hiddenAuxiliary.includes(item.measurement)) continue;
      const measured = state.measurements[item.measurement];
      if (!measured) continue;
      const row = document.createElement('div');
      row.className = 'reach-geometry-v2__row';
      row.dataset.geometryMeasurement = item.measurement;
      const name = document.createElement('span');
      name.textContent =
        item.label ?? auxiliaryReadingLabels.get(item.measurement) ?? item.measurement;
      const output = document.createElement('output');
      if (item.measurement.startsWith('L_') && !auxiliaryFeedbackVisible)
        output.textContent =
          spec.interaction.exploration.feedback === 'hidden' ? t('hiddenValue') : t('notChecked');
      else if (measured.status === 'valid')
        output.textContent = `${format(measured.value!, item.decimals ?? 2)} ${t(`unit.${measured.unit}`)}`;
      else {
        output.textContent = t('undefined');
        output.title = t(`reason.${measured.reason}`);
      }
      row.append(name, output);
      readings.append(row);
    }
    const relationPresentation = [
      ...spec.presentation.relations,
      ...state.auxiliary.presentation.relations,
    ];
    for (const item of relationPresentation) {
      if (item.visible === false || state.hiddenAuxiliary.includes(item.relation)) continue;
      const relation = state.relations[item.relation];
      if (!relation) continue;
      const row = document.createElement('div');
      row.className = 'reach-geometry-v2__row';
      row.dataset.geometryRelation = item.relation;
      const name = document.createElement('span');
      name.textContent = item.label ?? auxiliaryReadingLabels.get(item.relation) ?? item.relation;
      const output = document.createElement('output');
      if (item.relation.startsWith('L_') && !auxiliaryFeedbackVisible)
        output.textContent =
          spec.interaction.exploration.feedback === 'hidden' ? t('hiddenValue') : t('notChecked');
      else {
        output.textContent = t(geometryRelationMessageKeyV2(relation));
        if (relation.status !== 'valid') output.title = t(`reason.${relation.reason}`);
      }
      row.append(name, output);
      readings.append(row);
    }
    readingsPanel.hidden = readings.childElementCount === 0;
  };
  const schedule = () => {
    if (frame !== undefined || disposed || suspended || failed) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      try {
        paint();
      } catch {
        fail();
      }
    });
  };
  const actionButton = (
    key: string,
    icon: Parameters<typeof createElement>[0],
    action: () => void,
    attributes: Record<string, string> = {},
  ) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = t(key);
    button.setAttribute('aria-label', t(key));
    button.dataset.geometryAction = key;
    Object.entries(attributes).forEach(([name, value]) => button.setAttribute(name, value));
    button.append(createElement(icon, { 'aria-hidden': 'true', focusable: 'false' }));
    listen(button, 'click', (() => {
      if (!suspended && !failed) action();
    }) as EventListener);
    toolbar.append(button);
    return button;
  };
  const divider = () => {
    const node = document.createElement('span');
    node.className = 'reach-geometry-v2__divider';
    node.setAttribute('aria-hidden', 'true');
    toolbar.append(node);
  };
  const addNumberField = (
    name: string,
    range: GeometryRange,
    value: () => number,
    command: (next: number) => GeometrySessionCommandV2,
    key: string,
  ) => {
    const label = document.createElement('label');
    label.className = 'reach-geometry-v2__field';
    label.append(name);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(value());
    input.dataset.geometryInput = key;
    input.setAttribute('aria-label', name);
    listen(input, 'change', (() => {
      const result = control(command(Number(input.value)));
      if (!result.ok) {
        input.setAttribute('aria-invalid', 'true');
        input.value = String(value());
      } else input.removeAttribute('aria-invalid');
    }) as EventListener);
    label.append(input);
    inputs.append(label);
  };
  try {
    session = createGeometrySessionV2(envelope, context.instanceId, {
      ...(context.authoredSnapshot === undefined ? {} : { initial: context.authoredSnapshot }),
      ...(authoringExploration === undefined ? {} : { explorationPolicy: authoringExploration }),
    });
    view = factory(scene, envelope, fail);
    actionButton('undo', Undo2, () => control({ kind: 'undo' }));
    actionButton('redo', Redo2, () => control({ kind: 'redo' }));
    actionButton('reset', RotateCcw, () => control({ kind: 'reset' }));
    if (spec.interaction.exploration.feedback === 'onRequest')
      actionButton('checkResults', Search, () => {
        revealedGeometryRevision = session?.getComputedState().geometryRevision;
        schedule();
      });
    divider();
    actionButton('zoomIn', ZoomIn, () =>
      control({
        kind: 'setCamera',
        camera: zoomGeometryCamera(session!.getComputedState().camera, 1.2),
      }),
    );
    actionButton('zoomOut', ZoomOut, () =>
      control({
        kind: 'setCamera',
        camera: zoomGeometryCamera(session!.getComputedState().camera, 1 / 1.2),
      }),
    );
    divider();
    for (const tool of tools.filter(isToolAllowed)) {
      const button = actionButton(
        tool.key,
        tool.icon,
        () => {
          const next = activeTool === tool ? undefined : tool;
          cancelTool();
          if (next) {
            activeTool = next;
            button.setAttribute('aria-pressed', 'true');
            announce();
          }
        },
        { 'data-geometry-tool': tool.key, 'aria-pressed': 'false' },
      );
    }
    divider();
    actionButton('hide', EyeOff, () => {
      if (activeItem?.startsWith('L_'))
        control({
          kind: 'setAuxiliaryHidden',
          id: activeItem,
          hidden: !session!.getState().hiddenAuxiliary.includes(activeItem),
        });
    });
    actionButton('delete', Trash2, () => {
      if (!activeItem?.startsWith('L_')) return;
      const itemId = activeItem;
      const impact = session!.getDeleteImpact(itemId);
      if (!impact.ok) return;
      const remove = () => {
        control({ kind: 'deleteAuxiliary', id: itemId });
        activeItem = null;
      };
      if (impact.impact.ids.length > 1)
        requestConfirmation(
          `${t('confirmDeleteDependencies')}\n${impact.impact.ids.join(', ')}`,
          remove,
        );
      else remove();
    });
    actionButton('clearAuxiliary', Eraser, () => {
      if (
        !session!.getState().auxiliary.objects.length &&
        !session!.getState().auxiliary.measurements.length &&
        !session!.getState().auxiliary.relations.length
      )
        return;
      requestConfirmation(t('confirmClear'), () => {
        control({ kind: 'clearAuxiliary' });
        activeItem = null;
        cancelTool();
      });
    });
    for (const parameterId of spec.interaction.parameters) {
      const range = spec.parameters.find((entry) => entry.id === parameterId)!;
      addNumberField(
        parameterId,
        range,
        () => session!.getComputedState().inputs.parameters[parameterId]!,
        (value) => ({ kind: 'setParameter', id: parameterId, value }),
        `parameter:${parameterId}`,
      );
    }
    inputsPanel.hidden = inputs.childElementCount === 0;
    listen(candidatePicker, 'change', (() => {
      if (candidatePicker.value) choose(candidatePicker.value);
      candidatePicker.hidden = true;
    }) as EventListener);
    listen(selection, 'change', (() => {
      if (activeTool && selection.value) choose(selection.value);
      else {
        activeItem = selection.value || null;
        const selectedObject = objectDefinitions(session!.getComputedState()).has(selection.value);
        control({ kind: 'select', objectId: selectedObject ? selection.value : null });
        schedule();
      }
    }) as EventListener);
    listen(root, 'keydown', ((event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelTool();
        candidatePicker.hidden = true;
        event.preventDefault();
      } else if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        document.activeElement === scene &&
        activeItem?.startsWith('L_')
      ) {
        toolbar.querySelector<HTMLButtonElement>('[data-geometry-action="delete"]')?.click();
        event.preventDefault();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        control({ kind: event.shiftKey ? 'redo' : 'undo' });
        event.preventDefault();
      }
    }) as EventListener);
    type Drag = {
      pointerId: number;
      pixel: GeometryPixelV2;
      initial: GeometryComputedStateV2;
      freedom?: GeometryFreedom;
      anchor?: GeometryWorldV2;
      start?: { point: GeometryWorldV2; value: number | Readonly<Record<string, number>> };
      orbit: boolean;
    };
    let drag: Drag | undefined;
    const local = (event: PointerEvent): GeometryPixelV2 => {
      const box = scene.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    const finish = () => {
      if (drag && scene.hasPointerCapture?.(drag.pointerId))
        scene.releasePointerCapture(drag.pointerId);
      drag = undefined;
    };
    listen(scene, 'pointerdown', ((event: PointerEvent) => {
      if (suspended || failed || event.button !== 0 || drag) return;
      const pixel = local(event),
        current = session!.getComputedState(),
        candidates = view!.pickCandidates(pixel, event.pointerType === 'mouse' ? 'mouse' : 'touch');
      if (activeTool) {
        presentCandidates(candidates);
        scene.focus({ preventScroll: true });
        event.preventDefault();
        return;
      }
      if (candidates.length > 1) {
        presentCandidates(candidates);
        scene.focus({ preventScroll: true });
        event.preventDefault();
        return;
      }
      const hit = candidates[0];
      if (hit) choose(hit);
      else control({ kind: 'select', objectId: null });
      const freedoms = [...spec.interaction.freedoms, ...current.auxiliary.freedoms];
      const freedom = hit ? freedoms.find((entry) => entry.object === hit) : undefined;
      const object = freedom ? current.objects[freedom.object] : undefined;
      const anchor =
        freedom?.kind === 'translate' && object?.origin && object.direction
          ? object.origin.map((value, index) => value + object.direction![index] / 2)
          : (object?.coordinates ?? object?.origin);
      const point = freedom ? view!.dragPoint(pixel, freedom, current, anchor ?? undefined) : null;
      drag = {
        pointerId: event.pointerId,
        pixel,
        initial: current,
        freedom,
        anchor: anchor ?? undefined,
        start:
          point && freedom ? { point, value: current.inputs.freedoms[freedom.id]! } : undefined,
        orbit: !hit && spec.dimension === 3,
      };
      scene.setPointerCapture?.(event.pointerId);
      scene.focus({ preventScroll: true });
      event.preventDefault();
    }) as EventListener);
    listen(scene, 'pointermove', ((event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId || suspended || failed || activeTool) return;
      const pixel = local(event);
      if (drag.freedom) {
        const point = view!.dragPoint(
          pixel,
          drag.freedom,
          session!.getComputedState(),
          drag.anchor,
        );
        if (point) {
          const state = session!.getComputedState();
          const composedSpec = {
            ...parsed.projection.envelope.spec,
            objects: [...parsed.projection.envelope.spec.objects, ...state.auxiliary.objects],
            interaction: {
              ...parsed.projection.envelope.spec.interaction,
              freedoms: [
                ...parsed.projection.envelope.spec.interaction.freedoms,
                ...state.auxiliary.freedoms,
              ],
            },
          };
          const value = proposeFreedom(
            composedSpec,
            drag.freedom,
            state as never,
            point,
            drag.start,
          );
          if (value !== null)
            control({ kind: 'setFreedom', id: drag.freedom.id, value }, `drag_${drag.freedom.id}`);
        }
      } else if (drag.orbit)
        control(
          {
            kind: 'setCamera',
            camera: view!.orbit(
              drag.initial.camera,
              (pixel[0] - drag.pixel[0]) * 0.008,
              (pixel[1] - drag.pixel[1]) * 0.008,
            ),
          },
          'camera_orbit',
        );
      event.preventDefault();
    }) as EventListener);
    listen(scene, 'pointerup', ((event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) finish();
    }) as EventListener);
    listen(scene, 'pointercancel', finish as EventListener);
    listen(scene, 'lostpointercapture', (() => {
      drag = undefined;
    }) as EventListener);
    listen(
      scene,
      'wheel',
      ((event: WheelEvent) => {
        if (suspended || failed || activeTool) return;
        event.preventDefault();
        control(
          {
            kind: 'setCamera',
            camera: zoomGeometryCamera(
              session!.getComputedState().camera,
              Math.exp(-Math.sign(event.deltaY) * 0.12),
            ),
          },
          'camera_zoom',
        );
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
      finish();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      root
        .querySelectorAll('button,input,select')
        .forEach((node) => ((node as HTMLInputElement).disabled = true));
    }) as EventListener);
    listen(window, 'reach-interactive-resume', (() => {
      if (failed || disposed) return;
      suspended = false;
      root
        .querySelectorAll('button,input,select')
        .forEach((node) => ((node as HTMLInputElement).disabled = false));
      resize();
    }) as EventListener);
    announce();
    resize();
    paint();
  } catch (error) {
    fail();
    cleanups.forEach((cleanup) => cleanup());
    view?.dispose();
    session?.dispose();
    throw error;
  }
  return Object.freeze({
    reset: () => {
      if (!disposed) control({ kind: 'reset' });
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      cleanups.forEach((cleanup) => cleanup());
      view!.dispose();
      session!.dispose();
      target.replaceChildren();
    },
    getState: () => session!.getState(),
    setState: (state: unknown) => {
      if (disposed) return false;
      const candidate = createGeometrySessionV2(envelope, context.instanceId);
      try {
        const result = candidate.setState(state);
        if (!result.ok || (context.canAdoptState && !context.canAdoptState(candidate.getState())))
          return false;
        const adopted = session!.setState(candidate.getState());
        if (adopted.ok) schedule();
        return adopted.ok;
      } finally {
        candidate.dispose();
      }
    },
    getComputedState: () => session!.getComputedState(),
    applyCommand: (command: unknown) => apply(command, 'api'),
  });
}

export function geometryMountV2(factory: GeometryViewFactoryV2): ScienceKitMount {
  return (
    target: HTMLElement,
    _spec: Readonly<Record<string, unknown>>,
    context?: GeometryMountContextV2,
  ) => {
    if (!context) throw new Error('Geometry v2 mount context is required');
    return mountGeometryV2(target, context, factory);
  };
}
