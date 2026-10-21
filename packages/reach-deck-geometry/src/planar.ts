/// <reference lib="dom" preserve="true" />
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  type GeometryCamera,
  type GeometryMeasurement,
  type GeometrySpec,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import type { GeometryObjectState, GeometrySnapshot } from './index.js';
import { geometry, type NativeBoard, type NativeElement } from './native.js';

type Pair = readonly [number, number];
type PlanarCamera = Extract<GeometryCamera, { kind: 'planar' }>;
export interface GeometryEngineOptions {
  readonly planar?: { readonly container: HTMLElement };
}
export interface GeometryPlanarView {
  readonly camera: PlanarCamera;
  readonly selection: string | null;
  readonly visibleGroups: readonly string[];
}
export interface GeometryPlanarHit {
  readonly objectId: string;
  readonly freedomId?: string;
  readonly selectable: boolean;
}
export interface GeometryPlanarPresentation {
  paint(view: GeometryPlanarView): void;
  resize(width: number, height: number): void;
  project(point: Pair): Pair | null;
  unproject(point: Pair): Pair | null;
  pick(point: Pair, device: 'mouse' | 'touch'): GeometryPlanarHit | null;
  dispose(): void;
}
interface PlanarContext {
  board: NativeBoard;
  container: HTMLElement;
  spec: GeometrySpec;
  elements: ReadonlyMap<string, NativeElement>;
  snapshot(): GeometrySnapshot;
  assertAlive(): void;
  refresh(): void;
}
const colors = {
  ink: '#243447',
  muted: '#718096',
  accent: '#087e8b',
  success: '#16866d',
  warning: '#ae6a19',
};
const svgNamespace = 'http://www.w3.org/2000/svg';
const finitePair = (point: readonly number[]): boolean =>
  point.length === 2 && point.every(Number.isFinite);
const pair = (x: number, y: number): Pair | null =>
  Number.isFinite(x) && Number.isFinite(y) ? (Object.freeze([x, y]) as Pair) : null;
const sameBounds = (a: PlanarCamera, b: PlanarCamera): boolean =>
  a.bounds.every((value, index) => value === b.bounds[index]);
const readonlyView = (view: GeometryPlanarView): GeometryPlanarView =>
  Object.freeze({
    camera: Object.freeze({
      kind: 'planar' as const,
      bounds: Object.freeze([...view.camera.bounds]) as PlanarCamera['bounds'],
    }),
    selection: view.selection,
    visibleGroups: Object.freeze([...view.visibleGroups]),
  });

export function createPlanarPresentation(context: PlanarContext): GeometryPlanarPresentation {
  const { board, container, spec, elements } = context;
  const document = container.ownerDocument;
  const objectStyles = new Map(spec.presentation.objects.map((style) => [style.object, style]));
  const measurementStyles = new Map(
    spec.presentation.measurements.map((style) => [style.measurement, style]),
  );
  const groups = new Map(spec.presentation.groups.map((group) => [group.id, group]));
  const selectable = new Set(spec.interaction.selectable);
  const freedoms = new Map(
    spec.interaction.freedoms.map((freedom) => [freedom.object, freedom.id]),
  );
  const nativeIds = new Map([...elements].map(([id, element]) => [element.id, id]));
  const labels = new Map<string, HTMLSpanElement>();
  const measuredLabelSizes = new Map<string, Pair>();
  const marks = new Map<string, SVGPolylineElement>();
  let disposed = false,
    width = Math.max(container.clientWidth, 1),
    height = Math.max(container.clientHeight, 1);
  let view = readonlyView({
    camera: spec.presentation.camera as PlanarCamera,
    selection: null,
    visibleGroups: spec.interaction.visibleGroups,
  });
  let drawn: GeometrySnapshot;
  let visible = new Set<string>();
  const assertAlive = () => {
    context.assertAlive();
    if (disposed) throw new Error('disposed');
  };
  if (!container.style.position) container.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.setAttribute('data-reach-geometry-labels', '');
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    overflow: 'hidden',
  });
  const markerLayer = document.createElementNS(svgNamespace, 'svg');
  markerLayer.setAttribute('data-reach-geometry-marks', '');
  markerLayer.setAttribute('aria-hidden', 'true');
  Object.assign(markerLayer.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    overflow: 'hidden',
  });
  container.append(markerLayer, overlay);
  for (const [id, style] of objectStyles) {
    if (!style.label || !elements.has(id)) continue;
    const label = document.createElement('span');
    label.textContent = style.label;
    label.setAttribute('data-reach-geometry-label', id);
    Object.assign(label.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      font: '14px/1.3 system-ui, sans-serif',
      letterSpacing: '0',
      overflowWrap: 'anywhere',
      color: colors[style.colorToken ?? 'ink'],
      visibility: 'hidden',
    });
    overlay.append(label);
    labels.set(id, label);
  }
  for (const mark of spec.presentation.rightAngles) {
    const node = document.createElementNS(svgNamespace, 'polyline');
    node.setAttribute('data-reach-geometry-right-angle', mark.id);
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', colors.ink);
    node.setAttribute('stroke-width', '1.5');
    node.setAttribute('vector-effect', 'non-scaling-stroke');
    markerLayer.append(node);
    marks.set(mark.id, node);
  }
  const project = (point: Pair): Pair | null => {
    assertAlive();
    if (!finitePair(point)) return null;
    return pair(
      board.origin.scrCoords[1] + point[0] * board.unitX,
      board.origin.scrCoords[2] - point[1] * board.unitY,
    );
  };
  const unproject = (point: Pair): Pair | null => {
    assertAlive();
    if (!finitePair(point) || !(board.unitX > 0 && board.unitY > 0)) return null;
    return pair(
      (point[0] - board.origin.scrCoords[1]) / board.unitX,
      (board.origin.scrCoords[2] - point[1]) / board.unitY,
    );
  };
  const itemVisible = (
    id: string,
    type: 'objects' | 'measurements',
    current: GeometryPlanarView,
  ): boolean => {
    if ((type === 'objects' ? objectStyles.get(id) : measurementStyles.get(id))?.visible === false)
      return false;
    const owners = spec.presentation.groups.filter((group) => group[type].includes(id));
    return owners.length === 0 || owners.some((group) => current.visibleGroups.includes(group.id));
  };
  const anchor = (object: GeometryObjectState): Pair | null => {
    if (object.status !== 'valid') return null;
    if (object.radius !== undefined && object.coordinates)
      return pair(
        object.coordinates[0] + object.radius * Math.SQRT1_2,
        object.coordinates[1] + object.radius * Math.SQRT1_2,
      );
    if (object.coordinates) return pair(object.coordinates[0], object.coordinates[1]);
    if (object.origin && object.direction)
      return pair(
        object.origin[0] + object.direction[0] * (object.kind === 'segment' ? 0.5 : 0),
        object.origin[1] + object.direction[1] * (object.kind === 'segment' ? 0.5 : 0),
      );
    if (object.vertices?.length)
      return pair(
        object.vertices.reduce((sum, vertex) => sum + vertex[0] / object.vertices!.length, 0),
        object.vertices.reduce((sum, vertex) => sum + vertex[1] / object.vertices!.length, 0),
      );
    return null;
  };
  const drawLabels = (): void => {
    for (const label of labels.values())
      label.style.maxWidth = `${Math.max(24, Math.min(180, width - 12))}px`;
    // Read all label sizes before writing positions to avoid repeated synchronous layout.
    for (const [id, label] of labels)
      if (!measuredLabelSizes.has(id)) {
        const box = label.getBoundingClientRect();
        measuredLabelSizes.set(id, [box.width, box.height]);
      }
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const pointAnchors = [...visible].flatMap((id) => {
      const object = drawn.objects[id];
      const p =
        object.coordinates && object.radius === undefined
          ? project(object.coordinates as Pair)
          : null;
      return p ? [p] : [];
    });
    for (const [id, label] of [...labels].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const model = anchor(drawn.objects[id]),
        p = model ? project(model) : null;
      const shown =
        visible.has(id) && p && p[0] >= -8 && p[1] >= -8 && p[0] <= width + 8 && p[1] <= height + 8;
      label.style.visibility = shown ? 'visible' : 'hidden';
      if (!shown || !p) continue;
      const [w, h] = measuredLabelSizes.get(id)!;
      const choices = [
        [8, -h - 5],
        [8, 7],
        [-w - 8, -h - 5],
        [-w - 8, 7],
        [-w / 2, -h - 10],
        [-w / 2, 10],
      ];
      const candidates = choices.map(([dx, dy]) => ({
        x: Math.min(Math.max(4, p[0] + dx), Math.max(4, width - w - 4)),
        y: Math.min(Math.max(4, p[1] + dy), Math.max(4, height - h - 4)),
        w,
        h,
      }));
      const score = (box: (typeof placed)[number]) =>
        placed.reduce(
          (sum, other) =>
            sum +
            Math.max(
              0,
              Math.min(box.x + box.w + 3, other.x + other.w + 3) - Math.max(box.x, other.x),
            ) *
              Math.max(
                0,
                Math.min(box.y + box.h + 3, other.y + other.h + 3) - Math.max(box.y, other.y),
              ),
          0,
        ) +
        pointAnchors.filter(
          ([x, y]) =>
            x >= box.x - 5 && x <= box.x + box.w + 5 && y >= box.y - 5 && y <= box.y + box.h + 5,
        ).length *
          1000;
      candidates.sort((a, b) => score(a) - score(b));
      const box = candidates[0];
      placed.push(box);
      label.style.transform = `translate(${box.x}px, ${box.y}px)`;
    }
  };
  const measurementDirections = (
    measurement: GeometryMeasurement,
  ): { origin: Pair; first: Pair; second: Pair } | null => {
    if (measurement.kind === 'threePointAngle') {
      const a = drawn.objects[measurement.a],
        b = drawn.objects[measurement.b],
        vertex = drawn.objects[measurement.vertex];
      if (![measurement.a, measurement.b, measurement.vertex].every((id) => visible.has(id)))
        return null;
      if (!a.coordinates || !b.coordinates || !vertex.coordinates) return null;
      return {
        origin: vertex.coordinates as Pair,
        first: [a.coordinates[0] - vertex.coordinates[0], a.coordinates[1] - vertex.coordinates[1]],
        second: [
          b.coordinates[0] - vertex.coordinates[0],
          b.coordinates[1] - vertex.coordinates[1],
        ],
      };
    }
    if (
      measurement.kind !== 'lineAngle' ||
      !visible.has(measurement.line1) ||
      !visible.has(measurement.line2)
    )
      return null;
    const a = drawn.objects[measurement.line1],
      b = drawn.objects[measurement.line2];
    if (!a.origin || !b.origin || !a.direction || !b.direction) return null;
    const lengthA = Math.hypot(...a.direction),
      lengthB = Math.hypot(...b.direction);
    const n1 = [-a.direction[1] / lengthA, a.direction[0] / lengthA],
      n2 = [-b.direction[1] / lengthB, b.direction[0] / lengthB];
    const scale = Math.max(1, Math.hypot(b.origin[0] - a.origin[0], b.origin[1] - a.origin[1]));
    const offset = -(
      n2[0] * ((b.origin[0] - a.origin[0]) / scale) +
      n2[1] * ((b.origin[1] - a.origin[1]) / scale)
    );
    const result = geometry.meetLineLine(
      [0, ...n1, 0, 1, 1],
      [offset, ...n2, 0, 1, 1],
      0,
      board,
    ).usrCoords;
    const origin = pair(
      a.origin[0] + (result[1] / result[0]) * scale,
      a.origin[1] + (result[2] / result[0]) * scale,
    );
    if (!origin) return null;
    for (const line of [a, b]) {
      const dx = origin[0] - line.origin![0],
        dy = origin[1] - line.origin![1],
        d = line.direction!;
      const length = Math.hypot(...d),
        t = (dx * (d[0] / length) + dy * (d[1] / length)) / length;
      if (
        (line.kind === 'segment' && (t < -1e-9 || t > 1 + 1e-9)) ||
        (line.kind === 'ray' && t < -1e-9)
      )
        return null;
    }
    return { origin, first: a.direction as Pair, second: b.direction as Pair };
  };
  const drawMarks = (): void => {
    for (const mark of spec.presentation.rightAngles) {
      const element = marks.get(mark.id)!;
      const value = drawn.measurements[mark.measurement];
      const measurement = spec.measurements.find((entry) => entry.id === mark.measurement)!;
      const directions =
        value?.status === 'valid' &&
        Math.abs(value.value! - 90) <= EUCLIDEAN_GEOMETRY_CONTRACT.tolerances.angleDegrees &&
        itemVisible(mark.measurement, 'measurements', view)
          ? measurementDirections(measurement)
          : null;
      const origin = directions ? project(directions.origin) : null;
      if (!directions || !origin) {
        element.style.display = 'none';
        continue;
      }
      const screenDirection = ([x, y]: Pair): Pair | null => {
        const dx = x * board.unitX,
          dy = -y * board.unitY,
          length = Math.hypot(dx, dy);
        return length > 0 ? pair((dx / length) * 9, (dy / length) * 9) : null;
      };
      const a = screenDirection(directions.first),
        b = screenDirection(directions.second);
      if (!a || !b) {
        element.style.display = 'none';
        continue;
      }
      element.setAttribute(
        'points',
        [
          [origin[0] + a[0], origin[1] + a[1]],
          [origin[0] + a[0] + b[0], origin[1] + a[1] + b[1]],
          [origin[0] + b[0], origin[1] + b[1]],
        ]
          .map((point) => point.join(','))
          .join(' '),
      );
      element.style.display = '';
    }
  };
  const validateView = (next: GeometryPlanarView): void => {
    const camera = next.camera;
    if (
      camera?.kind !== 'planar' ||
      !Array.isArray(camera.bounds) ||
      camera.bounds.length !== 4 ||
      !camera.bounds.every(Number.isFinite) ||
      camera.bounds[0] >= camera.bounds[2] ||
      camera.bounds[1] >= camera.bounds[3] ||
      !Number.isFinite(camera.bounds[2] - camera.bounds[0]) ||
      !Number.isFinite(camera.bounds[3] - camera.bounds[1])
    )
      throw new Error('invalid_planar_camera');
    if (next.selection !== null && !selectable.has(next.selection))
      throw new Error('invalid_planar_selection');
    if (
      !Array.isArray(next.visibleGroups) ||
      new Set(next.visibleGroups).size !== next.visibleGroups.length ||
      next.visibleGroups.some((id) => !groups.has(id))
    )
      throw new Error('invalid_planar_groups');
  };
  const paint = (next: GeometryPlanarView): void => {
    assertAlive();
    validateView(next);
    const cameraChanged = !sameBounds(view.camera, next.camera);
    view = readonlyView(next);
    if (cameraChanged) {
      board.setBoundingBox(
        [
          view.camera.bounds[0],
          view.camera.bounds[3],
          view.camera.bounds[2],
          view.camera.bounds[1],
        ],
        true,
      );
      context.refresh();
    }
    drawn = context.snapshot();
    visible = new Set(
      [...elements.keys()].filter(
        (id) => drawn.objects[id].status === 'valid' && itemVisible(id, 'objects', view),
      ),
    );
    for (const [id, element] of elements) {
      const style = objectStyles.get(id),
        selected = view.selection === id;
      const token =
        style?.colorToken ??
        (drawn.objects[id].coordinates && drawn.objects[id].radius === undefined
          ? 'accent'
          : 'ink');
      const color = selected ? '#ba3b64' : colors[token];
      const shape = drawn.objects[id].kind === 'polygon';
      element.setAttribute({
        visible: visible.has(id),
        fixed: true,
        highlight: false,
        withLabel: false,
        strokeColor: color,
        fillColor: shape ? color : drawn.objects[id].radius !== undefined ? 'none' : color,
        strokeWidth: selected ? 3 : 1.8,
        size: freedoms.has(id) ? 5 : 3.5,
        strokeOpacity: style?.opacity ?? 1,
        fillOpacity: shape ? (style?.opacity ?? 0.14) : 1,
        dash: style?.lineStyle === 'dashed' ? 2 : style?.lineStyle === 'dotted' ? 1 : 0,
        hasInnerPoints: true,
        showInfobox: false,
      });
      if (element.rendNode) element.rendNode.setAttribute('data-reach-geometry-object', id);
    }
    // The authoritative callbacks already ran in dependency order. Only render here.
    for (const element of board.objectsList) {
      const id = nativeIds.get(element.id),
        shown = id !== undefined && visible.has(id);
      element.prepareUpdate?.();
      element.updateVisibility(shown);
      element.updateRenderer();
      if (id && drawn.objects[id].kind === 'polygon' && element.rendNode) {
        const style = objectStyles.get(id);
        element.rendNode.setAttribute(
          'stroke',
          view.selection === id ? '#ba3b64' : colors[style?.colorToken ?? 'ink'],
        );
        element.rendNode.setAttribute('stroke-width', view.selection === id ? '3' : '1.8');
        element.rendNode.setAttribute(
          'stroke-dasharray',
          style?.lineStyle === 'dashed' ? '6 4' : style?.lineStyle === 'dotted' ? '2 3' : 'none',
        );
      }
    }
    drawLabels();
    drawMarks();
  };
  const capability: GeometryPlanarPresentation = {
    paint,
    resize(nextWidth, nextHeight) {
      assertAlive();
      if (
        !Number.isFinite(nextWidth) ||
        !Number.isFinite(nextHeight) ||
        nextWidth <= 0 ||
        nextHeight <= 0
      )
        return;
      width = nextWidth;
      height = nextHeight;
      measuredLabelSizes.clear();
      board.resizeContainer(width, height, true, true);
      board.setBoundingBox(
        [
          view.camera.bounds[0],
          view.camera.bounds[3],
          view.camera.bounds[2],
          view.camera.bounds[1],
        ],
        true,
      );
      context.refresh();
      paint(view);
    },
    project,
    unproject,
    pick(point, device) {
      assertAlive();
      if (
        !finitePair(point) ||
        point[0] < 0 ||
        point[1] < 0 ||
        point[0] > width ||
        point[1] > height
      )
        return null;
      board.options.precision.hasPoint = device === 'touch' ? 18 : 9;
      const hits = [...elements].filter(
        ([id, element]) => visible.has(id) && element.hasPoint(point[0], point[1]),
      );
      const rank = (id: string) =>
        drawn.objects[id].coordinates && drawn.objects[id].radius === undefined
          ? 0
          : drawn.objects[id].kind === 'polygon'
            ? 2
            : 1;
      const distance = (id: string) => {
        const object = drawn.objects[id],
          p =
            object.coordinates && object.radius === undefined
              ? project(object.coordinates as Pair)
              : null;
        return p ? Math.hypot(p[0] - point[0], p[1] - point[1]) : 0;
      };
      hits.sort(
        ([a], [b]) => rank(a) - rank(b) || distance(a) - distance(b) || a.localeCompare(b, 'en'),
      );
      if (!hits.length) return null;
      const id = hits[0][0],
        freedomId = freedoms.get(id);
      return Object.freeze({
        objectId: id,
        ...(freedomId ? { freedomId } : {}),
        selectable: selectable.has(id),
      });
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        overlay.remove();
        markerLayer.remove();
        labels.clear();
        marks.clear();
        visible.clear();
      }
    },
  };
  try {
    capability.resize(width, height);
  } catch (error) {
    capability.dispose();
    throw error;
  }
  return Object.freeze(capability);
}
