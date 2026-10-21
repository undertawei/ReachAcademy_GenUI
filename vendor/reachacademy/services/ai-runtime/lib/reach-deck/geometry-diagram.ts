import { resolveReachDeckRuntimeAsset } from './runtime-assets';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { EUCLIDEAN_GEOMETRY_CONTRACT } from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  parseGeometryEnvelopeV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import type { GeometryComputedStateV2 } from '@reachany/reach-deck-geometry/server';
import { GeometryValidationWorkers } from './geometry-validation-worker.js';

const validators = new GeometryValidationWorkers();
/** Cache identity of the static renderer; bump whenever rendered pixels may change. */
export const GEOMETRY_DIAGRAM_RENDERER_VERSION = 'euclidean-geometry-v2-static/v3';
/** Cache identity of slot-sized renders (page-relative labels with density fit). */
export const GEOMETRY_DISPLAY_RENDERER_VERSION = 'euclidean-geometry-v2-static/v4/display';
/**
 * Slot-sized renders define text in displayed slide px. Labels follow the page body text:
 * primary = body, secondary = secondaryRatio × body, clamped to [floor, ceiling]. When no body
 * text is measurable, primary 22px and secondary 18px grow gently up to maxGrowth once the slot
 * exceeds referenceSlot px; strokes always follow that slot rule. If labels still collide, both
 * sizes shrink by densityStep per attempt down to the floor.
 */
export const GEOMETRY_DISPLAY_TYPOGRAPHY = Object.freeze({
  primary: 22,
  secondary: 18,
  referenceSlot: 560,
  maxGrowth: 1.4,
  secondaryRatio: 0.85,
  floor: 18,
  ceiling: 32,
  densityStep: 0.92,
});

/** Label font sizes in displayed slide px. */
export interface GeometryLabelSizes {
  primary: number;
  secondary: number;
}

/** Starting label sizes for a slot; see GEOMETRY_DISPLAY_TYPOGRAPHY. */
export function geometryDisplayLabelSizes(
  display: { width: number; height: number },
  bodyFontSize?: number,
): GeometryLabelSizes {
  const { primary, secondary, secondaryRatio, floor, ceiling } = GEOMETRY_DISPLAY_TYPOGRAPHY;
  if (bodyFontSize !== undefined && Number.isFinite(bodyFontSize) && bodyFontSize > 0) {
    const clamp = (value: number, max: number) => Math.min(max, Math.max(floor, Math.round(value)));
    return {
      primary: clamp(bodyFontSize, ceiling),
      secondary: clamp(bodyFontSize * secondaryRatio, Math.round(ceiling * secondaryRatio)),
    };
  }
  const growth = slotGrowth(display);
  return { primary: Math.round(primary * growth), secondary: Math.round(secondary * growth) };
}

function slotGrowth(display: { width: number; height: number }): number {
  const { referenceSlot, maxGrowth } = GEOMETRY_DISPLAY_TYPOGRAPHY;
  return Math.min(maxGrowth, Math.max(1, Math.max(display.width, display.height) / referenceSlot));
}
const colors = {
  ink: '#172024',
  muted: '#647178',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#b45309',
};
const pointKinds = new Set([
  'point',
  'freePoint',
  'midpoint',
  'pointOnCircle',
  'pointOnLine',
  'footToLine',
  'intersectLines',
  'intersectLineCircle',
  'transformPoint',
]);
const linearKinds = new Set(['line', 'ray', 'parallelLine', 'perpendicularLine']);
const transforms = new Set(['translate', 'rotate', 'scale', 'mirror']);
/** Right-angle marks follow the contract: defined and within angleDegrees of 90. */
const RIGHT_ANGLE_TOLERANCE_DEGREES = EUCLIDEAN_GEOMETRY_CONTRACT.tolerances.angleDegrees;
const escapeXml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!,
  );
const n = (value: number) => {
  if (!Number.isFinite(value)) throw new Error('Geometry diagram contains nonfinite coordinates');
  return Number(value.toFixed(3));
};

/**
 * Model-correctable content failure (contract, construction, assertion, right-angle or layout).
 * Infrastructure failures (worker unavailable, overload, cancellation) never use this class.
 */
export class GeometryDiagramContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryDiagramContentError';
  }
}

/** The legend does not fit at this text size; display renders retry smaller. */
class GeometryLayoutCapacityError extends GeometryDiagramContentError {}

/** How a visible measurement is written on the figure. */
export type GeometryMeasurementDisplay = 'value' | 'label' | 'labelAndValue' | 'none';

export interface RenderGeometryDiagramInput {
  envelope: unknown;
  width: number;
  height: number;
  signal?: AbortSignal;
  /**
   * `camera` (default) draws the envelope camera and rejects finite geometry outside it.
   * `geometry` ignores the camera and fits all visible finite geometry deterministically.
   */
  fit?: 'camera' | 'geometry';
  /** Optional per-measurement text policy; default is label = value (or value only). */
  measurementDisplay?: Readonly<Record<string, GeometryMeasurementDisplay>>;
  /**
   * Displayed size in slide px. When present, text and strokes follow
   * GEOMETRY_DISPLAY_TYPOGRAPHY times the raster pixel ratio (width / display.width);
   * otherwise they scale with the canvas itself. `labels` are the starting label sizes in
   * displayed px (default geometryDisplayLabelSizes without a body size); crowded labels shrink.
   */
  display?: { width: number; height: number; labels?: GeometryLabelSizes };
}

export interface GeometryDiagramRender {
  svg: string;
  /** Label sizes actually drawn, in displayed px; only for display renders. */
  labels?: GeometryLabelSizes;
  /** Texts whose best placement still overlaps a label, line, point or the canvas edge. */
  unresolvedLabels: string[];
}

/** Text sizes in raster px; typeScale spaces text, strokeScale sizes strokes and marks. */
interface Typography {
  typeScale: number;
  strokeScale: number;
  primarySize: number;
  secondarySize: number;
}

/** 1280px sources use 32px primary and 26px secondary text. */
function canvasTypography(input: RenderGeometryDiagramInput): Typography {
  const typeScale = Math.min(1.25, Math.max(0.7, Math.max(input.width, input.height) / 1280));
  return {
    typeScale,
    strokeScale: typeScale,
    primarySize: Math.round(32 * typeScale),
    secondarySize: Math.round(26 * typeScale),
  };
}

/** Every geometry computation runs in a disposable worker with a hard deadline. */
async function snapshot(
  envelope: GeometryEnvelopeV2,
  signal: AbortSignal,
): Promise<GeometryComputedStateV2> {
  signal.throwIfAborted();
  const serverUrl = pathToFileURL(resolveReachDeckRuntimeAsset('geometry-server')).href;
  const source = `const {parentPort,workerData}=require('node:worker_threads');
    import(workerData.serverUrl).then(({createGeometrySessionV2})=>{
      parentPort.postMessage({type:'ready'});
      let session;
      try {session=createGeometrySessionV2(workerData.envelope,'static-diagram');}
      catch {parentPort.postMessage({type:'construction-failed'});return;}
      try {parentPort.postMessage({type:'result',value:session.getComputedState()});} finally {session.dispose();}
    }).catch(()=>parentPort.postMessage({type:'failed'}));`;
  const worker = new Worker(source, {
    eval: true,
    workerData: { serverUrl, envelope },
    resourceLimits: { maxOldGenerationSizeMb: 96 },
  });
  return new Promise((resolve, reject) => {
    let finished = false;
    let compute: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: GeometryComputedStateV2) => {
      if (finished) return;
      finished = true;
      clearTimeout(total);
      clearTimeout(compute);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new Error('Geometry diagram computation aborted or timed out'));
    const total = setTimeout(abort, 10_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.on('error', () => finish(new Error('Geometry diagram computation unavailable')));
    worker.on('exit', () => {
      if (!finished) finish(new Error('Geometry diagram computation exited'));
    });
    worker.on('message', (message: { type?: string; value?: GeometryComputedStateV2 }) => {
      if (message.type === 'ready') {
        compute = setTimeout(abort, 2_000);
        return;
      }
      if (message.type === 'construction-failed') {
        finish(new GeometryDiagramContentError('Geometry construction could not be computed'));
        return;
      }
      if (message.type !== 'result' || !message.value) {
        finish(new Error('Geometry diagram computation unavailable'));
        return;
      }
      if (!message.value.valid) {
        const detail = message.value.diagnostics
          .slice(0, 8)
          .map((entry) => `${entry.code} at ${entry.path}`)
          .join('; ');
        finish(new GeometryDiagramContentError(`Geometry computation is invalid: ${detail}`));
        return;
      }
      finish(undefined, message.value);
    });
    if (signal.aborted) abort();
  });
}

type Vec = readonly [number, number];
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec, b: Vec) => a[0] * b[1] - a[1] * b[0];
const length = (a: Vec) => Math.hypot(a[0], a[1]);
const unit = (a: Vec): Vec | null => {
  const l = length(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : null;
};

/** Deterministic width estimate: CJK glyphs are one em, Latin glyphs roughly 0.6 em. */
function textWidth(text: string, size: number): number {
  let em = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code >= 0x2e80) em += 1;
    else if (character === ' ') em += 0.3;
    else if (/[.,:;°'|!il]/.test(character)) em += 0.35;
    else if (/[A-Z0-9=?+\-/]/.test(character)) em += 0.64;
    else em += 0.56;
  }
  return em * size;
}

/** Liang-Barsky clip: does segment pq cross the rectangle? */
function segmentHitsBox(p: Vec, q: Vec, box: Box): boolean {
  let t0 = 0,
    t1 = 1;
  const d = sub(q, p);
  const checks: [number, number][] = [
    [-d[0], p[0] - box.x],
    [d[0], box.x + box.w - p[0]],
    [-d[1], p[1] - box.y],
    [d[1], box.y + box.h - p[1]],
  ];
  for (const [pk, qk] of checks) {
    if (Math.abs(pk) < 1e-12) {
      if (qk < 0) return false;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function overlapArea(a: Box, b: Box): number {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  );
}

/** Formats host-computed values; trailing zeros are trimmed so 10.00 reads as 10. */
function formatValue(value: number, decimals: number, unitName: string): string {
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  if (text === '-0') text = '0';
  if (unitName === 'degree') return `${text}°`;
  if (unitName === 'unit' || !unitName) return text;
  return `${text} ${unitName}`;
}

export async function renderGeometryDiagramSvg(input: RenderGeometryDiagramInput): Promise<string> {
  return (await renderGeometryDiagram(input)).svg;
}

const roundTenth = (value: number) => Math.round(value * 10) / 10;

/**
 * Validates and computes the envelope once, then lays it out. Display renders start at
 * `display.labels` and, while any label is unresolved, retry with both sizes times densityStep
 * (never below the floor); the floor render is returned with its unresolved labels.
 */
export async function renderGeometryDiagram(
  input: RenderGeometryDiagramInput,
): Promise<GeometryDiagramRender> {
  const display = input.display;
  if (display !== undefined) {
    const values = [display.width, display.height];
    if (display.labels) values.push(display.labels.primary, display.labels.secondary);
    if (!values.every((value) => Number.isFinite(value) && value > 0))
      throw new Error('Geometry diagram display size must be positive');
  }
  const layout = await prepareGeometryLayout(input);
  if (display === undefined) return layout(canvasTypography(input));
  const ratio = Math.min(input.width / display.width, input.height / display.height);
  const strokeScale =
    Math.round(GEOMETRY_DISPLAY_TYPOGRAPHY.primary * slotGrowth(display) * ratio) / 32;
  const { floor, densityStep } = GEOMETRY_DISPLAY_TYPOGRAPHY;
  let labels = display.labels ?? geometryDisplayLabelSizes(display);
  for (;;) {
    const shrink = (value: number) =>
      Math.min(value, Math.max(floor, roundTenth(value * densityStep)));
    const next = { primary: shrink(labels.primary), secondary: shrink(labels.secondary) };
    const atFloor = next.primary === labels.primary && next.secondary === labels.secondary;
    const primarySize = Math.round(labels.primary * ratio);
    let result: GeometryDiagramRender;
    try {
      result = layout({
        typeScale: primarySize / 32,
        strokeScale,
        primarySize,
        secondarySize: Math.round(labels.secondary * ratio),
      });
    } catch (error) {
      if (!(error instanceof GeometryLayoutCapacityError) || atFloor) throw error;
      labels = next;
      continue;
    }
    if (!result.unresolvedLabels.length || atFloor) return { ...result, labels };
    labels = next;
  }
}

/** Everything that does not depend on text size: validation, computation and camera bounds. */
async function prepareGeometryLayout(
  input: RenderGeometryDiagramInput,
): Promise<(typography: Typography) => GeometryDiagramRender> {
  const signal =
    input.signal === undefined
      ? AbortSignal.timeout(15_000)
      : AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  signal.throwIfAborted();
  if (
    ![input.width, input.height].every(
      (value) => Number.isInteger(value) && value >= 200 && value <= 2048,
    )
  )
    throw new Error('Geometry diagram dimensions must be bounded');
  let envelope: GeometryEnvelopeV2;
  try {
    envelope = parseGeometryEnvelopeV2(input.envelope).envelope;
  } catch (error) {
    throw new GeometryDiagramContentError(
      `Geometry contract violation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { spec } = envelope;
  if (spec.dimension !== 2 || spec.presentation.camera.kind !== 'planar')
    throw new GeometryDiagramContentError('Geometry diagram supports planar 2D only');
  if (
    spec.presentation.relations.some((entry) => entry.visible !== false) ||
    spec.presentation.groups.length
  )
    throw new GeometryDiagramContentError(
      'Geometry diagram does not yet support relation or grouped visibility annotations',
    );
  const supported = new Set([
    ...pointKinds,
    ...linearKinds,
    ...transforms,
    'segment',
    'circle',
    'polygon',
  ]);
  const unsupportedObject = spec.objects.find((object) => !supported.has(object.kind));
  if (unsupportedObject)
    throw new GeometryDiagramContentError(
      `Geometry diagram has an unsupported object kind ${unsupportedObject.kind}`,
    );
  const validation = await validators.evaluate(
    [{ instanceId: 'static-diagram', envelope, state: null }],
    signal,
  );
  const result = validation.results[0];
  if (!result?.valid)
    throw new GeometryDiagramContentError(
      `Geometry diagram assertions or construction failed validation: ${(result?.diagnostics ?? [])
        .slice(0, 8)
        .map((entry) => `${entry.code} at ${entry.path}`)
        .join('; ')}`,
    );
  const computed = await snapshot(envelope, signal);
  const failedAssertions = Object.entries(computed.assertions)
    .filter(([, assertion]) => assertion.status !== 'valid' || assertion.value !== true)
    .map(([id]) => id);
  if (failedAssertions.length)
    throw new GeometryDiagramContentError(
      `Geometry diagram assertion failed: ${failedAssertions.join(', ')}`,
    );

  const objectPresentation = new Map(
    spec.presentation.objects.map((entry) => [entry.object, entry]),
  );
  const definitions = new Map(spec.objects.map((object) => [object.id, object]));
  const measurementDefinitions = new Map(spec.measurements.map((entry) => [entry.id, entry]));
  const isVisible = (id: string) =>
    objectPresentation.get(id)?.visible !== false && !transforms.has(definitions.get(id)!.kind);
  const position = (id: string): Vec => {
    const state = computed.objects[id];
    if (!state || state.status !== 'valid' || !state.coordinates)
      throw new GeometryDiagramContentError(`Geometry diagram point ${id} is undefined`);
    return [state.coordinates[0]!, state.coordinates[1]!];
  };

  // Right angles are checked before layout so an approximate figure fails with a precise reason.
  const rightAngleMeasurements = new Set<string>();
  for (const [index, mark] of spec.presentation.rightAngles.entries()) {
    const value = computed.measurements[mark.measurement];
    if (!value || value.status !== 'valid' || value.value === null)
      throw new GeometryDiagramContentError(
        `presentation.rightAngles[${index}] measurement ${mark.measurement} is undefined`,
      );
    if (Math.abs(value.value - 90) > RIGHT_ANGLE_TOLERANCE_DEGREES)
      throw new GeometryDiagramContentError(
        `presentation.rightAngles[${index}] measurement ${mark.measurement} is ${value.value.toFixed(4)} degrees, not 90; guarantee the right angle by construction (perpendicularLine, footToLine or exact axis-aligned coordinates) and a perpendicular assertion`,
      );
    rightAngleMeasurements.add(mark.measurement);
  }

  // Collect visible geometry in model coordinates.
  const visibleObjects = spec.objects.filter((object) => isVisible(object.id));
  for (const object of visibleObjects) {
    const state = computed.objects[object.id];
    if (!state || state.status !== 'valid')
      throw new GeometryDiagramContentError(`Geometry diagram object ${object.id} is undefined`);
  }
  const finite: Vec[] = [];
  for (const object of visibleObjects) {
    const state = computed.objects[object.id]!;
    if (pointKinds.has(object.kind)) finite.push(position(object.id));
    else if (object.kind === 'segment') finite.push(position(object.a), position(object.b));
    else if (object.kind === 'ray') finite.push(position(object.a));
    else if (object.kind === 'polygon')
      state.vertices?.forEach((vertex) => finite.push([vertex[0]!, vertex[1]!]));
    else if (object.kind === 'circle') {
      const center = position(object.id);
      const radius = state.radius!;
      if (!Number.isFinite(radius) || radius <= 0)
        throw new GeometryDiagramContentError(`Geometry diagram circle ${object.id} is invalid`);
      finite.push(
        [center[0] - radius, center[1] - radius],
        [center[0] + radius, center[1] + radius],
      );
    }
  }
  const visibleMeasurements = spec.presentation.measurements.filter(
    (entry) => entry.visible !== false,
  );
  for (const presentation of visibleMeasurements) {
    const value = computed.measurements[presentation.measurement];
    if (!value || value.status !== 'valid' || value.value === null)
      throw new GeometryDiagramContentError(
        `Geometry diagram measurement ${presentation.measurement} is undefined`,
      );
  }

  let bounds: [number, number, number, number];
  if (input.fit === 'geometry') {
    if (!finite.length)
      throw new GeometryDiagramContentError('Geometry diagram has no visible finite geometry');
    let [xmin, ymin, xmax, ymax] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of finite) {
      xmin = Math.min(xmin, x);
      xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
    }
    const span = Math.max(xmax - xmin, ymax - ymin, 1e-6);
    const padding = span * 0.04;
    bounds = [xmin - padding, ymin - padding, xmax + padding, ymax + padding];
    if (xmax - xmin < span * 0.1) {
      bounds[0] -= span * 0.05;
      bounds[2] += span * 0.05;
    }
    if (ymax - ymin < span * 0.1) {
      bounds[1] -= span * 0.05;
      bounds[3] += span * 0.05;
    }
  } else {
    bounds = [...spec.presentation.camera.bounds] as [number, number, number, number];
    for (const point of finite)
      if (
        point[0] < bounds[0] ||
        point[0] > bounds[2] ||
        point[1] < bounds[1] ||
        point[1] > bounds[3]
      )
        throw new GeometryDiagramContentError(
          'Geometry diagram visible object extends outside camera bounds',
        );
  }
  const [xmin, ymin, xmax, ymax] = bounds;

  return ({ typeScale, strokeScale, primarySize, secondarySize }: Typography) => {
    const lineHeight = 1.25;

    const allCentroid = (() => {
      const points = visibleObjects.filter((object) => pointKinds.has(object.kind));
      const source = points.length ? points.map((object) => position(object.id)) : finite;
      return mul(
        source.reduce<Vec>((sum, point) => add(sum, point), [0, 0]),
        1 / Math.max(1, source.length),
      );
    })();

    // Measurements that cannot be attached to the figure fall back to a legend.
    const displayOf = (id: string, label: string | undefined): GeometryMeasurementDisplay =>
      input.measurementDisplay?.[id] ?? (label ? 'labelAndValue' : 'value');
    const measurementText = (id: string): string | null => {
      const presentation = spec.presentation.measurements.find(
        (entry) => entry.measurement === id,
      )!;
      const value = computed.measurements[id]!;
      const formatted = formatValue(value.value!, presentation.decimals ?? 2, value.unit);
      const display = displayOf(id, presentation.label);
      if (display === 'none') return null;
      if (display === 'label') return presentation.label ?? formatted;
      if (display === 'labelAndValue' && presentation.label)
        return `${presentation.label} = ${formatted}`;
      return formatted;
    };
    const onFigure = (id: string) => {
      const kind = measurementDefinitions.get(id)!.kind;
      return (
        kind === 'distance' ||
        kind === 'threePointAngle' ||
        (kind === 'lineAngle' && rightAngleMeasurements.has(id))
      );
    };
    const legend = visibleMeasurements
      .filter((entry) => !onFigure(entry.measurement))
      .map((entry) => measurementText(entry.measurement))
      .filter((text): text is string => text !== null);
    const legendHeight = legend.length ? legend.length * secondarySize * 1.4 + 24 : 0;
    if (legendHeight > input.height * 0.4)
      throw new GeometryLayoutCapacityError(
        'Geometry diagram measurements exceed readable layout capacity',
      );
    const margin = Math.round(primarySize * 1.9);
    const availableWidth = input.width - margin * 2,
      availableHeight = input.height - legendHeight - margin * 2;
    const scale = Math.min(availableWidth / (xmax - xmin), availableHeight / (ymax - ymin));
    if (!Number.isFinite(scale) || scale <= 0)
      throw new GeometryDiagramContentError('Geometry diagram camera bounds invalid');
    const left = (input.width - (xmax - xmin) * scale) / 2;
    const top = (input.height - legendHeight - (ymax - ymin) * scale) / 2;
    const project = (coordinates: readonly number[]): Vec => [
      left + (coordinates[0]! - xmin) * scale,
      top + (ymax - coordinates[1]!) * scale,
    ];
    const centroid = project(allCentroid);

    const drawings: string[] = [];
    const pointDrawings: string[] = [];
    const marks: string[] = [];
    const texts: string[] = [];
    const obstacles: [Vec, Vec][] = [];
    const dots: Vec[] = [];
    const placed: Box[] = [];
    const unresolvedLabels: string[] = [];
    const strokeWidth = n(4 * strokeScale);
    const styleFor = (id: string) => {
      const presentation = objectPresentation.get(id);
      const stroke = colors[presentation?.colorToken ?? 'ink'];
      const dash =
        presentation?.lineStyle === 'dashed'
          ? ` stroke-dasharray="${n(14 * strokeScale)} ${n(9 * strokeScale)}"`
          : presentation?.lineStyle === 'dotted'
            ? ` stroke-dasharray="${n(3 * strokeScale)} ${n(8 * strokeScale)}" stroke-linecap="round"`
            : '';
      return {
        stroke,
        attributes: `stroke="${stroke}" stroke-width="${strokeWidth}" fill="none" stroke-linejoin="round" opacity="${presentation?.opacity ?? 1}"${dash}`,
      };
    };
    const polygonFor = (vertexIds: readonly string[]) =>
      visibleObjects.find(
        (object) =>
          object.kind === 'polygon' && vertexIds.every((id) => object.vertices.includes(id)),
      );
    const polygonCentroid = (id: string): Vec => {
      const vertices = computed.objects[id]!.vertices!.map(project);
      return mul(
        vertices.reduce<Vec>((sum, point) => add(sum, point), [0, 0]),
        1 / vertices.length,
      );
    };

    interface Candidate {
      center: Vec;
      cost: number;
    }
    const scoreBox = (box: Box, ownDots: readonly Vec[]): number => {
      let cost = 0;
      if (
        box.x < 4 ||
        box.y < 4 ||
        box.x + box.w > input.width - 4 ||
        box.y + box.h > input.height - 4
      )
        cost += 1_000_000;
      const padded = { x: box.x - 4, y: box.y - 3, w: box.w + 8, h: box.h + 6 };
      for (const other of placed) cost += overlapArea(padded, other) * 60;
      for (const [p, q] of obstacles) if (segmentHitsBox(p, q, padded)) cost += 6000;
      for (const dot of [...dots, ...ownDots])
        if (
          dot[0] >= padded.x - 6 &&
          dot[0] <= padded.x + padded.w + 6 &&
          dot[1] >= padded.y - 6 &&
          dot[1] <= padded.y + padded.h + 6
        )
          cost += 8000;
      return cost;
    };
    /** Places text at the cheapest candidate; ties keep candidate order, so layout is stable. */
    const placeText = (
      text: string,
      size: number,
      fill: string,
      weight: number,
      candidates: (w: number, h: number) => Candidate[],
      ownDots: readonly Vec[] = [],
    ) => {
      const w = textWidth(text, size),
        h = size * lineHeight;
      let best: { box: Box; cost: number; collision: number } | undefined;
      for (const candidate of candidates(w, h)) {
        const box = { x: candidate.center[0] - w / 2, y: candidate.center[1] - h / 2, w, h };
        const collision = scoreBox(box, ownDots);
        const cost = candidate.cost + collision;
        if (!best || cost < best.cost) best = { box, cost, collision };
      }
      if (!best) return;
      // Collision cost at the chosen candidate means no candidate was clear.
      if (best.collision > 0) unresolvedLabels.push(text);
      placed.push(best.box);
      texts.push(
        `<text x="${n(best.box.x + w / 2)}" y="${n(best.box.y + h / 2)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>`,
      );
    };
    /** Distance from an anchor to the box edge in direction d (support function of the box). */
    const support = (d: Vec, w: number, h: number) =>
      (Math.abs(d[0]) * w) / 2 + (Math.abs(d[1]) * h) / 2;
    const outwardNormal = (a: Vec, b: Vec, reference: Vec): Vec => {
      const direction = unit(sub(b, a)) ?? [1, 0];
      let normal: Vec = [-direction[1], direction[0]];
      const mid = mul(add(a, b), 0.5);
      const side = dot(normal, sub(mid, reference));
      if (side < -1e-6 || (Math.abs(side) <= 1e-6 && normal[1] > 0)) normal = mul(normal, -1);
      return normal;
    };
    const alongSegmentCandidates =
      (a: Vec, b: Vec, reference: Vec, gap: number) =>
      (w: number, h: number): Candidate[] => {
        const normal = outwardNormal(a, b, reference);
        const result: Candidate[] = [];
        for (const [sideIndex, side] of [1, -1].entries())
          for (const [offsetIndex, extra] of [0, gap * 1.6].entries())
            for (const [tIndex, t] of [0.5, 0.4, 0.6, 0.3, 0.7].entries()) {
              const anchor = add(a, mul(sub(b, a), t));
              const d = mul(normal, side);
              result.push({
                center: add(anchor, mul(d, gap + extra + support(d, w, h))),
                cost: sideIndex * 900 + offsetIndex * 150 + tIndex * 60,
              });
            }
        return result;
      };

    // Shapes: polygons first so strokes of segments and marks stay on top.
    const order = [...visibleObjects].sort((a, b) => {
      const rank = (kind: string) =>
        kind === 'polygon'
          ? 0
          : kind === 'circle'
            ? 1
            : linearKinds.has(kind)
              ? 2
              : kind === 'segment'
                ? 3
                : 4;
      return rank(a.kind) - rank(b.kind);
    });
    const lineLabelJobs: (() => void)[] = [];
    for (const definition of order) {
      const state = computed.objects[definition.id]!;
      const presentation = objectPresentation.get(definition.id);
      const style = styleFor(definition.id);
      if (definition.kind === 'polygon') {
        const points = state.vertices!.map(project);
        drawings.push(
          `<polygon points="${points.map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" ${style.attributes.replace('fill="none"', `fill="${style.stroke}" fill-opacity="0.06"`)}/>`,
        );
        points.forEach((point, index) =>
          obstacles.push([point, points[(index + 1) % points.length]!]),
        );
        if (presentation?.label) {
          const center = polygonCentroid(definition.id);
          lineLabelJobs.push(() =>
            placeText(presentation.label!, secondarySize, style.stroke, 500, () => [
              { center, cost: 0 },
              { center: add(center, [0, secondarySize]), cost: 100 },
              { center: add(center, [0, -secondarySize]), cost: 100 },
            ]),
          );
        }
      } else if (definition.kind === 'circle') {
        const center = project(position(definition.id));
        const radius = state.radius! * scale;
        drawings.push(
          `<circle cx="${n(center[0])}" cy="${n(center[1])}" r="${n(radius)}" ${style.attributes}/>`,
        );
        const steps = 48;
        for (let index = 0; index < steps; index += 1) {
          const a0 = (index / steps) * Math.PI * 2,
            a1 = ((index + 1) / steps) * Math.PI * 2;
          obstacles.push([
            add(center, [Math.cos(a0) * radius, Math.sin(a0) * radius]),
            add(center, [Math.cos(a1) * radius, Math.sin(a1) * radius]),
          ]);
        }
        if (presentation?.label)
          lineLabelJobs.push(() =>
            placeText(presentation.label!, secondarySize, style.stroke, 500, (w, h) =>
              [-45, -135, 45, 135, 0, 180, -90, 90].map((degrees, index) => {
                const d: Vec = [
                  Math.cos((degrees * Math.PI) / 180),
                  Math.sin((degrees * Math.PI) / 180),
                ];
                return {
                  center: add(center, mul(d, radius + 10 + support(d, w, h))),
                  cost: index * 40,
                };
              }),
            ),
          );
      } else if (linearKinds.has(definition.kind)) {
        const origin = state.origin!,
          direction = state.direction!;
        if (!origin || !direction)
          throw new GeometryDiagramContentError(
            `Geometry diagram line ${definition.id} unavailable`,
          );
        let lo = definition.kind === 'ray' ? 0 : -Infinity,
          hi = Infinity;
        for (const [axis, min, max] of [
          [0, xmin, xmax],
          [1, ymin, ymax],
        ] as const) {
          if (Math.abs(direction[axis]!) < 1e-12) {
            if (origin[axis]! < min || origin[axis]! > max)
              throw new GeometryDiagramContentError(
                `Geometry diagram line ${definition.id} outside camera`,
              );
            continue;
          }
          const t1 = (min - origin[axis]!) / direction[axis]!,
            t2 = (max - origin[axis]!) / direction[axis]!;
          lo = Math.max(lo, Math.min(t1, t2));
          hi = Math.min(hi, Math.max(t1, t2));
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi)
          throw new GeometryDiagramContentError(
            `Geometry diagram line ${definition.id} outside camera`,
          );
        const a = project([origin[0]! + lo * direction[0]!, origin[1]! + lo * direction[1]!]),
          b = project([origin[0]! + hi * direction[0]!, origin[1]! + hi * direction[1]!]);
        drawings.push(
          `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" ${style.attributes} stroke-linecap="round"/>`,
        );
        obstacles.push([a, b]);
        if (presentation?.label) {
          const d = unit(sub(b, a)) ?? [1, 0];
          const normal: Vec = [-d[1], d[0]];
          lineLabelJobs.push(() =>
            placeText(presentation.label!, secondarySize, style.stroke, 500, (w, h) =>
              [0.88, 0.12, 0.7, 0.3].flatMap((t, index) =>
                [normal, mul(normal, -1)].map((side, sideIndex) => ({
                  center: add(add(a, mul(sub(b, a), t)), mul(side, 10 + support(side, w, h))),
                  cost: index * 50 + sideIndex * 20,
                })),
              ),
            ),
          );
        }
      } else if (definition.kind === 'segment') {
        const a = project(position(definition.a)),
          b = project(position(definition.b));
        drawings.push(
          `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" ${style.attributes} stroke-linecap="round"/>`,
        );
        obstacles.push([a, b]);
        if (presentation?.label) {
          const polygon = polygonFor([definition.a, definition.b]);
          const reference = polygon ? polygonCentroid(polygon.id) : centroid;
          lineLabelJobs.push(() =>
            placeText(
              presentation.label!,
              secondarySize,
              style.stroke,
              500,
              alongSegmentCandidates(a, b, reference, 10 * typeScale),
            ),
          );
        }
      } else if (pointKinds.has(definition.kind)) {
        const p = project(position(definition.id));
        dots.push(p);
        pointDrawings.push(
          `<circle cx="${n(p[0])}" cy="${n(p[1])}" r="${n(6 * strokeScale)}" fill="${style.stroke}"/>`,
        );
      } else
        throw new GeometryDiagramContentError(`Geometry diagram cannot render ${definition.kind}`);
    }

    // Angle geometry for arcs and right-angle marks, always derived from the computed rays.
    const angleRays = (id: string): { vertex: Vec; first: Vec; second: Vec } | null => {
      const measurement = measurementDefinitions.get(id)!;
      if (measurement.kind === 'threePointAngle') {
        const vertex = project(position(measurement.vertex));
        return {
          vertex,
          first: sub(project(position(measurement.a)), vertex),
          second: sub(project(position(measurement.b)), vertex),
        };
      }
      if (measurement.kind !== 'lineAngle') return null;
      const first = computed.objects[measurement.line1]!,
        second = computed.objects[measurement.line2]!;
      if (!first.origin || !first.direction || !second.origin || !second.direction) return null;
      const o1 = project(first.origin),
        o2 = project(first.origin.map((value, index) => value + first.direction![index]!)),
        p1 = project(second.origin),
        p2 = project(second.origin.map((value, index) => value + second.direction![index]!));
      const d1 = sub(o2, o1),
        d2 = sub(p2, p1);
      const denominator = cross(d1, d2);
      if (Math.abs(denominator) < 1e-9) return null;
      const t = cross(sub(p1, o1), d2) / denominator;
      const vertex = add(o1, mul(d1, t));
      // Point each ray toward the drawn body of its linear object (farther defining point).
      const toward = (a: Vec, b: Vec): Vec =>
        length(sub(a, vertex)) >= length(sub(b, vertex)) ? sub(a, vertex) : sub(b, vertex);
      return { vertex, first: toward(o1, o2), second: toward(p1, p2) };
    };
    const angleLabelJobs: (() => void)[] = [];
    const arcsAtVertex = new Map<string, number>();
    for (const presentation of visibleMeasurements) {
      const id = presentation.measurement;
      const kind = measurementDefinitions.get(id)!.kind;
      if (kind !== 'threePointAngle' && !(kind === 'lineAngle' && rightAngleMeasurements.has(id)))
        continue;
      const rays = angleRays(id);
      if (!rays)
        throw new GeometryDiagramContentError(`Geometry diagram angle ${id} has no vertex`);
      const u1 = unit(rays.first),
        u2 = unit(rays.second);
      if (!u1 || !u2)
        throw new GeometryDiagramContentError(`Geometry diagram angle ${id} has a zero-length ray`);
      const shortest = Math.min(length(rays.first), length(rays.second));
      const key = `${Math.round(rays.vertex[0])},${Math.round(rays.vertex[1])}`;
      const nth = arcsAtVertex.get(key) ?? 0;
      arcsAtVertex.set(key, nth + 1);
      let bisector = unit(add(u1, u2));
      if (!bisector) {
        const normal: Vec = [-u1[1], u1[0]];
        bisector = dot(normal, sub(rays.vertex, centroid)) >= 0 ? normal : mul(normal, -1);
      }
      let reach: number;
      if (rightAngleMeasurements.has(id)) {
        const side = Math.min(
          Math.min(Math.max(shortest * 0.08, 22 * strokeScale), 32 * strokeScale),
          shortest * 0.35,
        );
        const a = add(rays.vertex, mul(u1, side)),
          corner = add(a, mul(u2, side)),
          b = add(rays.vertex, mul(u2, side));
        marks.push(
          `<polyline data-right-angle="${escapeXml(id)}" points="${[a, corner, b].map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" fill="none" stroke="${colors.ink}" stroke-width="${n(2.5 * strokeScale)}" stroke-linejoin="miter"/>`,
        );
        obstacles.push([a, corner], [corner, b]);
        reach = side * Math.SQRT2;
      } else {
        const radius = Math.min(
          Math.min(Math.max(shortest * 0.14, 40 * strokeScale), 84 * strokeScale) +
            nth * 14 * strokeScale,
          Math.max(shortest * 0.6, 12),
        );
        const start = add(rays.vertex, mul(u1, radius)),
          end = add(rays.vertex, mul(u2, radius));
        // Small interior arc: never the large arc; sweep follows the screen-space turn from u1 to u2.
        const sweep = cross(u1, u2) > 0 ? 1 : 0;
        marks.push(
          `<path data-angle-arc="${escapeXml(id)}" d="M ${n(start[0])} ${n(start[1])} A ${n(radius)} ${n(radius)} 0 0 ${sweep} ${n(end[0])} ${n(end[1])}" fill="none" stroke="${colors.accent}" stroke-width="${n(3 * strokeScale)}"/>`,
        );
        const theta = Math.atan2(cross(u1, u2), dot(u1, u2));
        const steps = 12;
        for (let index = 0; index < steps; index += 1) {
          const r0 = (theta * index) / steps,
            r1 = (theta * (index + 1)) / steps;
          const rotate = (angle: number): Vec => [
            u1[0] * Math.cos(angle) - u1[1] * Math.sin(angle),
            u1[0] * Math.sin(angle) + u1[1] * Math.cos(angle),
          ];
          obstacles.push([
            add(rays.vertex, mul(rotate(r0), radius)),
            add(rays.vertex, mul(rotate(r1), radius)),
          ]);
        }
        reach = radius;
      }
      const text = measurementText(id);
      if (text !== null) {
        const vertex = rays.vertex,
          direction = bisector;
        const fill = rightAngleMeasurements.has(id) ? colors.ink : colors.accent;
        angleLabelJobs.push(() =>
          placeText(text, secondarySize, fill, 500, (w, h) =>
            [1, 1.5, 2.1, 2.8].flatMap((factor, index) =>
              [0, 0.3, -0.3].map((turn, turnIndex) => {
                const d: Vec = [
                  direction[0] * Math.cos(turn) - direction[1] * Math.sin(turn),
                  direction[0] * Math.sin(turn) + direction[1] * Math.cos(turn),
                ];
                return {
                  center: add(vertex, mul(d, reach * factor + 8 + support(d, w, h))),
                  cost: index * 120 + turnIndex * 90,
                };
              }),
            ),
          ),
        );
      }
    }

    // Distance measurements sit beside the measured pair, on the outward side of the figure.
    const distanceJobs: (() => void)[] = [];
    for (const presentation of visibleMeasurements) {
      const measurement = measurementDefinitions.get(presentation.measurement)!;
      if (measurement.kind !== 'distance') continue;
      const text = measurementText(measurement.id);
      if (text === null) continue;
      const a = project(position(measurement.a)),
        b = project(position(measurement.b));
      const polygon = polygonFor([measurement.a, measurement.b]);
      const reference = polygon ? polygonCentroid(polygon.id) : centroid;
      distanceJobs.push(() =>
        placeText(
          text,
          secondarySize,
          colors.ink,
          500,
          alongSegmentCandidates(a, b, reference, 10 * typeScale),
        ),
      );
    }

    // Point labels go outward from the figure and away from incident lines and other labels.
    const pointJobs: (() => void)[] = [];
    for (const definition of visibleObjects) {
      if (!pointKinds.has(definition.kind)) continue;
      const label = objectPresentation.get(definition.id)?.label;
      if (!label) continue;
      const p = project(position(definition.id));
      const polygon = visibleObjects.find(
        (object) => object.kind === 'polygon' && object.vertices.includes(definition.id),
      );
      const reference = polygon ? polygonCentroid(polygon.id) : centroid;
      const outward = unit(sub(p, reference)) ?? [0, -1];
      const color = styleFor(definition.id).stroke;
      pointJobs.push(() =>
        placeText(
          label,
          primarySize,
          color,
          600,
          (w, h) =>
            Array.from({ length: 16 }, (_, index) => {
              const angle = (index * Math.PI) / 8;
              const d: Vec = [Math.cos(angle), Math.sin(angle)];
              return {
                center: add(p, mul(d, 10 * typeScale + support(d, w, h))),
                cost: (1 - dot(d, outward)) * 400,
              };
            }),
          [],
        ),
      );
    }
    for (const job of [...pointJobs, ...angleLabelJobs, ...lineLabelJobs, ...distanceJobs]) job();

    legend.forEach((text, index) => {
      texts.push(
        `<text x="${margin}" y="${n(input.height - legendHeight + 12 + (index + 0.5) * secondarySize * 1.4)}" font-size="${secondarySize}" fill="${colors.ink}" dominant-baseline="central">${escapeXml(text)}</text>`,
      );
    });
    signal.throwIfAborted();
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}" role="img"><title>${escapeXml(spec.ariaLabel)}</title><g>${drawings.join('')}</g><g>${marks.join('')}</g><g>${pointDrawings.join('')}</g><g font-family="Source Han Sans VF, sans-serif">${texts.join('')}</g></svg>`,
      unresolvedLabels,
    };
  };
}
