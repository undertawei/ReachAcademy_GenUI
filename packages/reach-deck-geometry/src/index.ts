import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  evaluateGeometryScalar,
  geometryObjectDependencies,
  parseGeometryEnvelope,
  type GeometryAssertion,
  type GeometryMeasurement,
  type GeometryObject,
  type GeometryRange,
  type GeometryScalar,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  createBoard,
  createView,
  disposeBoard,
  geometry,
  math,
  type NativeElement,
} from './native.js';
import {
  ANGLE_TOLERANCE,
  DIRECTION_TOLERANCE,
  UndefinedGeometry,
  angle,
  axpy,
  cross,
  dot,
  faceFrame,
  finite,
  finiteNumber,
  footToLine,
  footToPlane,
  frame,
  intersectLineCircle,
  intersectPlanes,
  norm,
  onPlane,
  spatial,
  sub,
  tolerance,
  undef,
  unit,
  type Frame,
  type Reason,
  type Vector,
} from './math.js';
import {
  createPlanarPresentation,
  type GeometryEngineOptions,
  type GeometryPlanarPresentation,
} from './planar.js';
export type {
  GeometryEngineOptions,
  GeometryPlanarPresentation,
  GeometryPlanarView,
  GeometryPlanarHit,
} from './planar.js';

export const GEOMETRY_EVALUATOR_VERSION = EUCLIDEAN_GEOMETRY_CONTRACT.evaluatorVersion;
export interface GeometryDiagnostic {
  readonly code: string;
  readonly path: string;
}
export interface GeometryInputPatch {
  readonly parameters?: Readonly<Record<string, number>>;
  readonly freedoms?: Readonly<Record<string, number | Readonly<Record<string, number>>>>;
}
export interface GeometryInputState {
  readonly parameters: Readonly<Record<string, number>>;
  readonly freedoms: Readonly<Record<string, number | Readonly<Record<string, number>>>>;
}
export interface GeometryObjectState {
  readonly kind: GeometryObject['kind'];
  readonly status: 'valid' | 'undefined';
  readonly reason: string | null;
  readonly coordinates: readonly number[] | null;
  readonly origin?: readonly number[];
  readonly direction?: readonly number[];
  readonly frame?: Readonly<{
    origin: readonly number[];
    u: readonly number[];
    v: readonly number[];
    n: readonly number[];
  }>;
  readonly radius?: number;
  readonly vertices?: readonly (readonly number[])[];
  readonly vertexIds?: readonly string[];
  readonly faces?: readonly string[];
  readonly matrix?: readonly (readonly number[])[];
}
export interface GeometryMeasurementState {
  readonly value: number | null;
  readonly unit: string;
  readonly status: 'valid' | 'undefined';
  readonly reason: string | null;
}
export interface GeometryAssertionState {
  readonly value: boolean | null;
  readonly status: 'valid' | 'undefined';
  readonly reason: string | null;
}
export interface GeometrySnapshot {
  readonly revision: number;
  readonly valid: boolean;
  readonly inputs: GeometryInputState;
  readonly objects: Readonly<Record<string, GeometryObjectState>>;
  readonly measurements: Readonly<Record<string, GeometryMeasurementState>>;
  readonly assertions: Readonly<Record<string, GeometryAssertionState>>;
  readonly diagnostics: readonly GeometryDiagnostic[];
}
export interface GeometryEngine {
  readonly planarPresentation?: GeometryPlanarPresentation;
  snapshot(): GeometrySnapshot;
  applyInputs(patch: GeometryInputPatch): GeometrySnapshot;
  reset(): GeometrySnapshot;
  dispose(): void;
}
export class GeometryInputError extends Error {
  constructor(readonly code: 'invalid_input' | 'unknown_input' | 'input_conflict' | 'disposed') {
    super(code);
  }
}
interface Linear {
  origin: Vector;
  direction: Vector;
  domain: 'line' | 'segment' | 'ray';
}
interface Node {
  object: GeometryObject;
  dependencies: readonly string[];
  elements: NativeElement[];
  reason: Reason | null;
  check(): void;
  after(): void;
  point?: NativeElement;
  renderElement?: NativeElement;
  linear?: () => Linear;
  plane?: () => Frame;
  circle?: NativeElement;
  transform?: (point: Vector) => Vector;
  matrix?: () => number[][];
}
interface InputBinding {
  readonly key: string;
  readonly field: string;
  readonly range: GeometryRange;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new GeometryInputError('invalid_input');
}
function domain(line: Linear, t: number): void {
  const length = norm(line.direction);
  const epsilon = tolerance(length) / length;
  if (
    (line.domain === 'segment' && (t < -epsilon || t > 1 + epsilon)) ||
    (line.domain === 'ray' && t < -epsilon)
  )
    undef('outside_domain');
}

export function createGeometryEngine(
  input: unknown,
  options: GeometryEngineOptions = {},
): GeometryEngine {
  const { envelope, objectOrder } = parseGeometryEnvelope(input);
  const spec = envelope.spec,
    dimension = spec.dimension;
  if (options.planar && dimension !== 2) throw new Error('planar_presentation_requires_2d');
  const byId = new Map(spec.objects.map((object) => [object.id, object]));
  const nodes = new Map<string, Node>();
  const initial = new Map<string, number>(
    spec.parameters.map((parameter) => [`parameter:${parameter.id}`, parameter.initial]),
  );
  const parameterRanges = new Map(spec.parameters.map((parameter) => [parameter.id, parameter]));
  const bindings = new Map<string, InputBinding[]>();
  for (const freedom of spec.interaction.freedoms) {
    let target = byId.get(freedom.object)!;
    const fields: [string, string, GeometryRange][] = [];
    if (freedom.kind === 'freePoint') fields.push(['x', 'x', freedom.x], ['y', 'y', freedom.y]);
    else if (freedom.kind === 'line' || freedom.kind === 'circle')
      fields.push(['value', freedom.kind === 'line' ? 't' : 'angle', freedom.range]);
    else if (freedom.kind === 'plane') fields.push(['u', 'u', freedom.u], ['v', 'v', freedom.v]);
    else if (freedom.kind === 'translate') {
      const endpoint = byId.get(
        (target as Extract<GeometryObject, { kind: 'segment' | 'line' | 'ray' | 'midpoint' }>).a,
      )!;
      target = byId.get(
        (endpoint as Extract<GeometryObject, { kind: 'transformPoint' }>).transform,
      )!;
      for (const range of freedom.ranges) fields.push([range.axis, `d${range.axis}`, range]);
    }
    bindings.set(
      freedom.id,
      fields.map(([field, objectField, range]) => {
        const scalar = (target as unknown as Record<string, GeometryScalar>)[objectField];
        const key =
          typeof scalar === 'number'
            ? `object:${target.id}:${objectField}`
            : `parameter:${(scalar as { parameter: string }).parameter}`;
        if (typeof scalar === 'number') initial.set(key, scalar);
        return { key, field, range };
      }),
    );
  }
  let inputs = new Map(initial),
    revision = 0,
    disposed = false;
  const board = createBoard(
    options.planar
      ? {
          container: options.planar.container,
          bounds: (
            spec.presentation.camera as { bounds: readonly [number, number, number, number] }
          ).bounds,
          ariaLabel: spec.ariaLabel,
        }
      : undefined,
  );
  let view: NativeElement | undefined;
  const attrs = { fixed: true, visible: false, withLabel: false, name: '', dump: false };
  const coords = (point: NativeElement): Vector =>
    dimension === 2 ? [point.X(), point.Y()] : [point.X(), point.Y(), point.Z()];
  const required = (id: string): Node => {
    const node = nodes.get(id)!;
    if (node.reason) undef('dependency_undefined');
    return node;
  };
  const point = (id: string): Vector => finite(coords(required(id).point!));
  const linear = (id: string): Linear => required(id).linear!();
  const plane = (id: string): Frame => required(id).plane!();
  const scalar = (object: GeometryObject, field: string): number => {
    const override = inputs.get(`object:${object.id}:${field}`);
    if (override !== undefined) return override;
    const expression = (object as unknown as Record<string, GeometryScalar>)[field];
    const result = evaluateGeometryScalar(
      expression,
      Object.fromEntries(
        spec.parameters.map((parameter) => [
          parameter.id,
          inputs.get(`parameter:${parameter.id}`)!,
        ]),
      ),
    );
    if (result.status === 'undefined')
      undef(result.reason === 'non_finite_result' ? 'non_finite_result' : 'scalar_undefined');
    return result.value;
  };
  const safe = (node: Node, calculate: () => Vector): Vector => {
    try {
      for (const dependency of node.dependencies) required(dependency);
      const output = finite(calculate());
      return output;
    } catch (error) {
      if (!(error instanceof UndefinedGeometry)) throw error;
      node.reason = error.reason;
      return Array(dimension).fill(NaN) as number[];
    }
  };
  const wire = (element: NativeElement, node: Node): void => {
    const ancestors = new Set<NativeElement>();
    const visit = (id: string): void => {
      const parent = nodes.get(id)!;
      for (const native of parent.elements) if (native.addChild) ancestors.add(native);
      // Native transformations are not GeometryElements and have no dependency methods.
      if (parent.elements.every((native) => !native.addChild)) parent.dependencies.forEach(visit);
    };
    node.dependencies.forEach(visit);
    element.addParents?.([...ancestors]);
    for (const parent of ancestors) parent.addChild?.(element);
  };
  const nativePoint = (node: Node, calculate: () => Vector): NativeElement => {
    const wrapped = () => safe(node, calculate);
    const element =
      dimension === 2
        ? board.create('point', [wrapped], attrs)
        : view!.create('point3d', [wrapped], attrs);
    node.elements.push(element);
    wire(element, node);
    return element;
  };
  const nativeLine = (
    node: Node,
    a: NativeElement,
    b: NativeElement,
    kind: Linear['domain'],
  ): void => {
    const options = { ...attrs, straightFirst: kind === 'line', straightLast: kind !== 'segment' };
    const element =
      dimension === 2
        ? board.create('line', [a, b], options)
        : view!.create('line3d', [a, b], options);
    node.elements.push(element);
    wire(element, node);
    node.renderElement = element;
    node.linear = () => ({
      origin: finite(coords(a)),
      direction: finite(sub(coords(b), coords(a))),
      domain: kind,
    });
    node.after = () => {
      unit(node.linear!().direction);
    };
  };
  const nativeDirectedLine = (node: Node, origin: NativeElement, direction: () => Vector): void => {
    let element: NativeElement;
    if (dimension === 3) {
      element = view!.create(
        'line3d',
        [origin, () => safe(node, direction), [-Infinity, Infinity]],
        attrs,
      );
      node.linear = () => ({
        origin: finite(coords(element.point)),
        direction: finite(element.vec.slice(1)),
        domain: 'line',
      });
    } else {
      // A separate native vector carrier preserves affine magnitude at large origins.
      const vector = nativePoint(node, direction);
      const coefficient = (index: number): number => {
        try {
          const d = unit(coords(vector)),
            n = [-d[1], d[0]],
            o = coords(origin);
          return finiteNumber(index === 0 ? -dot(n, o) : n[index - 1]);
        } catch (error) {
          if (!(error instanceof UndefinedGeometry)) throw error;
          node.reason = error.reason;
          return NaN;
        }
      };
      element = board.create(
        'line',
        [() => coefficient(0), () => coefficient(1), () => coefficient(2)],
        attrs,
      );
      vector.addChild?.(element);
      element.addParents?.([vector, origin]);
      origin.addChild?.(element);
      node.linear = () => ({
        origin: finite(coords(origin)),
        direction: finite(coords(vector)),
        domain: 'line',
      });
    }
    node.elements.push(element);
    wire(element, node);
    node.renderElement = element;
    node.after = () => {
      unit(node.linear!().direction);
    };
  };
  const createTransform = (node: Node, kind: string, parameters: unknown[]): NativeElement => {
    const guarded = parameters.map((parameter, index) =>
      typeof parameter !== 'function'
        ? parameter
        : () => {
            try {
              return parameter();
            } catch (error) {
              if (!(error instanceof UndefinedGeometry)) throw error;
              node.reason = error.reason;
              return dimension === 3 && kind === 'rotate' && index > 0 ? [NaN, NaN, NaN] : NaN;
            }
          },
    );
    const element =
      dimension === 2
        ? board.create('transform', guarded, { type: kind })
        : view!.create('transform3d', guarded, { type: kind });
    node.after = () => {
      for (const transform of node.elements) if (transform.matrix) finite(transform.matrix.flat());
    };
    node.elements.push(element);
    return element;
  };
  const refresh = (): void => {
    for (const node of nodes.values()) {
      node.reason = null;
      try {
        node.dependencies.forEach(required);
        node.check();
      } catch (error) {
        if (!(error instanceof UndefinedGeometry)) throw error;
        node.reason = error.reason;
      }
      for (const element of node.elements) {
        try {
          element.prepareUpdate?.();
          element.update();
          element.updateNormal?.();
        } catch (error) {
          if (!(error instanceof UndefinedGeometry)) throw error;
          node.reason ??= error.reason;
        }
      }
      if (!node.reason) {
        try {
          node.after();
        } catch (error) {
          if (!(error instanceof UndefinedGeometry)) throw error;
          node.reason = error.reason;
        }
      }
    }
  };
  try {
    if (dimension === 3) view = createView(board);
    for (const id of objectOrder) {
      const object = byId.get(id)!;
      const node: Node = {
        object,
        dependencies: geometryObjectDependencies(object, dimension),
        elements: [],
        reason: null,
        check() {},
        after() {},
      };
      nodes.set(id, node);
      switch (object.kind) {
        case 'point':
        case 'freePoint':
          node.point = nativePoint(node, () =>
            (dimension === 2 ? ['x', 'y'] : ['x', 'y', 'z']).map((field) => scalar(object, field)),
          );
          break;
        case 'midpoint':
          node.point = nativePoint(node, () =>
            axpy(
              0.5,
              point(object.b),
              point(object.a).map((value) => value * 0.5),
            ),
          );
          break;
        case 'line':
        case 'segment':
        case 'ray':
          nativeLine(node, nodes.get(object.a)!.point!, nodes.get(object.b)!.point!, object.kind);
          break;
        case 'parallelLine':
        case 'perpendicularLine':
        case 'normalLine': {
          const origin = nodes.get(object.point)!.point!;
          nativeDirectedLine(node, origin, () => {
            let direction: Vector;
            if (object.kind === 'normalLine') direction = plane(object.plane).n;
            else {
              direction = linear((object as { line: string }).line).direction;
              if (object.kind === 'perpendicularLine') direction = [-direction[1], direction[0]];
            }
            return direction;
          });
          break;
        }
        case 'circle': {
          node.check = () => {
            if (scalar(object, 'radius') <= tolerance(scalar(object, 'radius')))
              undef('invalid_radius');
          };
          node.circle = board.create(
            'circle',
            [
              nodes.get(object.center)!.point!,
              () => {
                try {
                  node.dependencies.forEach(required);
                  node.check();
                  return scalar(object, 'radius');
                } catch (error) {
                  if (!(error instanceof UndefinedGeometry)) throw error;
                  node.reason = error.reason;
                  return NaN;
                }
              },
            ],
            attrs,
          );
          node.elements.push(node.circle);
          node.renderElement = node.circle;
          wire(node.circle, node);
          break;
        }
        case 'pointOnCircle':
          node.point = nativePoint(node, () => {
            const circle = required(object.circle).circle!,
              radians = scalar(object, 'angle');
            return axpy(
              circle.Radius(),
              [Math.cos(radians), Math.sin(radians)],
              coords(circle.center),
            );
          });
          break;
        case 'pointOnLine':
          node.point = nativePoint(node, () => {
            const line = linear(object.line),
              t = scalar(object, 't');
            domain(line, t);
            return axpy(t, line.direction, line.origin);
          });
          break;
        case 'plane':
        case 'parallelPlane': {
          const getFrame = () =>
            object.kind === 'plane'
              ? frame(point(object.origin), point(object.uPoint), point(object.vPoint))
              : { ...plane(object.plane), origin: point(object.point) };
          node.check = () => {
            getFrame();
          };
          const origin = nodes.get(object.kind === 'plane' ? object.origin : object.point)!.point!;
          const vector = (axis: 'u' | 'v') => () => {
            try {
              return getFrame()[axis].slice();
            } catch (error) {
              if (!(error instanceof UndefinedGeometry)) throw error;
              node.reason = error.reason;
              return [NaN, NaN, NaN];
            }
          };
          const element = view!.create(
            'plane3d',
            [origin, vector('u'), vector('v'), [-Infinity, Infinity], [-Infinity, Infinity]],
            { ...attrs, type: 'wireframe' },
          );
          node.elements.push(element);
          wire(element, node);
          node.plane = () => ({
            origin: finite(coords(element.point)),
            u: finite(element.vec1.slice(1)),
            v: finite(element.vec2.slice(1)),
            n: finite(element.normal.slice(1)),
          });
          break;
        }
        case 'pointOnPlane':
          node.point = nativePoint(node, () => {
            const f = plane(object.plane);
            return axpy(scalar(object, 'v'), f.v, axpy(scalar(object, 'u'), f.u, f.origin));
          });
          break;
        case 'footToLine':
          node.point = nativePoint(node, () => {
            const line = linear(object.line);
            return footToLine(point(object.point), line.origin, line.direction);
          });
          break;
        case 'footToPlane':
          node.point = nativePoint(node, () =>
            footToPlane(point(object.point), plane(object.plane)),
          );
          break;
        case 'intersectLines':
          node.point = nativePoint(node, () => {
            const first = linear(object.line1),
              second = linear(object.line2);
            const a = unit(first.direction),
              b = unit(second.direction);
            if (norm(cross(a, b)) <= DIRECTION_TOLERANCE) {
              const residual = norm(
                sub(second.origin, footToLine(second.origin, first.origin, first.direction)),
              );
              undef(
                residual <= tolerance(norm(sub(second.origin, first.origin)))
                  ? 'coincident_no_unique_intersection'
                  : 'parallel_no_intersection',
              );
            }
            const origin = first.origin,
              delta = finite(sub(second.origin, origin));
            const scale = Math.max(norm(delta), 1);
            const normal1 = [-a[1], a[0]],
              normal2 = [-b[1], b[0]];
            const result = geometry.meetLineLine(
              [0, ...normal1, 0, 1, 1],
              [
                -dot(
                  normal2,
                  delta.map((x) => x / scale),
                ),
                ...normal2,
                0,
                1,
                1,
              ],
              0,
              board,
            ).usrCoords;
            const p = finite(axpy(scale / result[0], result.slice(1), origin));
            domain(first, dot(sub(p, first.origin), a) / norm(first.direction));
            domain(second, dot(sub(p, second.origin), b) / norm(second.direction));
            return p;
          });
          break;
        case 'intersectLineCircle':
          node.point = nativePoint(node, () => {
            const line = linear(object.line),
              circle = required(object.circle).circle!;
            const result = intersectLineCircle(
              board,
              line.origin,
              line.direction,
              coords(circle.center),
              circle.Radius(),
              object.branch,
            );
            domain(line, result.t);
            return result.point;
          });
          break;
        case 'intersectLinePlane':
          node.point = nativePoint(node, () => {
            const line = linear(object.line),
              f = plane(object.plane),
              direction = unit(line.direction);
            const divisor = dot(direction, f.n);
            if (Math.abs(divisor) <= DIRECTION_TOLERANCE)
              undef(
                onPlane(line.origin, f)
                  ? 'coincident_no_unique_intersection'
                  : 'parallel_no_intersection',
              );
            const distance = dot(finite(sub(f.origin, line.origin)), f.n) / divisor;
            domain(line, distance / norm(line.direction));
            return axpy(distance, direction, line.origin);
          });
          break;
        case 'intersectPlanes': {
          const solve = () => intersectPlanes(plane(object.plane1), plane(object.plane2));
          const origin = nativePoint(node, () => solve().origin);
          nativeDirectedLine(node, origin, () => solve().direction);
          break;
        }
        case 'polygon':
        case 'face': {
          node.check = () => {
            faceFrame(object.vertices.map(point));
          };
          const parents = object.vertices.map((id) => nodes.get(id)!.point!);
          const element =
            dimension === 2
              ? board.create('polygon', parents, { ...attrs, withLines: false })
              : view!.create('polygon3d', [parents], { ...attrs, withLines: false });
          node.elements.push(element);
          wire(element, node);
          node.renderElement = element;
          break;
        }
        case 'polyhedron':
          node.check = () => {
            if (object.closed)
              validateClosedPolyhedron(
                object.faces.map(
                  (id) =>
                    (byId.get(id) as Extract<GeometryObject, { kind: 'polygon' | 'face' }>)
                      .vertices,
                ),
              );
          };
          break;
        case 'translate': {
          const fields = dimension === 2 ? ['dx', 'dy'] : ['dx', 'dy', 'dz'];
          node.check = () => {
            fields.forEach((field) => scalar(object, field));
          };
          const transform = createTransform(
            node,
            'translate',
            fields.map((field) => () => scalar(object, field)),
          );
          node.matrix = () => transform.matrix;
          node.transform = (p) => math.matVecMult(transform.matrix, [1, ...p]).slice(1);
          break;
        }
        case 'rotate': {
          node.check = () => {
            scalar(object, 'angle');
            if (dimension === 3) unit(linear(object.axis!).direction);
          };
          const parameters =
            dimension === 2
              ? [() => scalar(object, 'angle'), nodes.get(object.center!)!.point!]
              : [
                  () => scalar(object, 'angle'),
                  () => unit(linear(object.axis!).direction).slice(),
                  () => linear(object.axis!).origin.slice(),
                ];
          const transform = createTransform(node, 'rotate', parameters);
          node.matrix = () => transform.matrix;
          node.transform = (p) => math.matVecMult(transform.matrix, [1, ...p]).slice(1);
          break;
        }
        case 'scale': {
          node.check = () => {
            if (scalar(object, 'factor') <= 0) undef('invalid_scale');
          };
          const axes = Array.from({ length: dimension }, (_, index) => index);
          const before = createTransform(
            node,
            'translate',
            axes.map((index) => () => -point(object.center)[index]),
          );
          const scaling = createTransform(
            node,
            'scale',
            axes.map(() => () => scalar(object, 'factor')),
          );
          const after = createTransform(
            node,
            'translate',
            axes.map((index) => () => point(object.center)[index]),
          );
          node.transform = (p) =>
            [before, scaling, after]
              .reduce((value, transform) => math.matVecMult(transform.matrix, value), [1, ...p])
              .slice(1);
          break;
        }
        case 'mirror':
          node.transform = (p) => {
            const foot =
              dimension === 2
                ? (() => {
                    const line = linear(object.line!);
                    return footToLine(p, line.origin, line.direction);
                  })()
                : footToPlane(p, plane(object.plane!));
            return axpy(2, sub(foot, p), p);
          };
          break;
        case 'transformPoint':
          node.point = nativePoint(node, () =>
            required(object.transform).transform!(point(object.point)),
          );
          break;
      }
      // Initialize each native node before any downstream constructor reads it.
      node.reason = null;
      try {
        node.dependencies.forEach(required);
        node.check();
      } catch (error) {
        if (!(error instanceof UndefinedGeometry)) throw error;
        node.reason = error.reason;
      }
      for (const element of node.elements) {
        try {
          element.prepareUpdate?.();
          element.update();
          element.updateNormal?.();
        } catch (error) {
          if (!(error instanceof UndefinedGeometry)) throw error;
          node.reason ??= error.reason;
        }
      }
      if (!node.reason)
        try {
          node.after();
        } catch (error) {
          if (!(error instanceof UndefinedGeometry)) throw error;
          node.reason = error.reason;
        }
    }
    refresh();
  } catch (error) {
    disposeBoard(board);
    throw error;
  }

  const measure = (measurement: GeometryMeasurement): GeometryMeasurementState => {
    const length = [
      'distance',
      'pointLineDistance',
      'pointSegmentDistance',
      'pointPlaneDistance',
    ].includes(measurement.kind);
    const outputUnit = length ? spec.units : 'degree';
    try {
      let value: number;
      switch (measurement.kind) {
        case 'distance':
          value = norm(sub(point(measurement.a), point(measurement.b)));
          break;
        case 'pointLineDistance':
        case 'pointSegmentDistance': {
          const line = linear(
              measurement.kind === 'pointLineDistance' ? measurement.line : measurement.segment,
            ),
            p = point(measurement.point);
          value = norm(
            sub(
              p,
              footToLine(
                p,
                line.origin,
                line.direction,
                measurement.kind === 'pointSegmentDistance',
              ),
            ),
          );
          break;
        }
        case 'pointPlaneDistance': {
          const p = point(measurement.point);
          value = norm(sub(p, footToPlane(p, plane(measurement.plane))));
          break;
        }
        case 'lineAngle':
          value = angle(
            linear(measurement.line1).direction,
            linear(measurement.line2).direction,
            true,
          );
          break;
        case 'threePointAngle':
          value = angle(
            sub(point(measurement.a), point(measurement.vertex)),
            sub(point(measurement.b), point(measurement.vertex)),
          );
          break;
        case 'linePlaneAngle':
          value = angle(
            linear(measurement.line).direction,
            plane(measurement.plane).n,
            false,
            true,
          );
          break;
        case 'planeAngle':
          value = angle(plane(measurement.plane1).n, plane(measurement.plane2).n, true);
          break;
        case 'dihedralAngle': {
          const edge = linear(measurement.edge),
            first = plane(measurement.plane1),
            second = plane(measurement.plane2);
          const q1 = point(measurement.q1),
            q2 = point(measurement.q2),
            e = unit(edge.direction);
          if (
            !onPlane(edge.origin, first) ||
            !onPlane(edge.origin, second) ||
            Math.abs(dot(e, first.n)) > DIRECTION_TOLERANCE ||
            Math.abs(dot(e, second.n)) > DIRECTION_TOLERANCE ||
            !onPlane(q1, first) ||
            !onPlane(q2, second)
          )
            undef('invalid_incidence');
          const u = finite(sub(q1, edge.origin)),
            v = finite(sub(q2, edge.origin));
          const up = axpy(-dot(u, e), e, u),
            vp = axpy(-dot(v, e), e, v);
          const scale = Math.max(norm(edge.direction), norm(u), norm(v));
          value = angle(
            unit(up, 'half_plane_reference_on_edge', scale),
            unit(vp, 'half_plane_reference_on_edge', scale),
          );
          break;
        }
      }
      return { value: finiteNumber(value), unit: outputUnit, status: 'valid', reason: null };
    } catch (error) {
      if (!(error instanceof UndefinedGeometry)) throw error;
      return { value: null, unit: outputUnit, status: 'undefined', reason: error.reason };
    }
  };
  const assert = (
    assertion: GeometryAssertion,
    measurements: Record<string, GeometryMeasurementState>,
  ): GeometryAssertionState => {
    try {
      let value: boolean;
      switch (assertion.kind) {
        case 'onLine': {
          const p = point(assertion.point),
            line = linear(assertion.line),
            offset = sub(p, line.origin);
          const threshold = tolerance(norm(offset)),
            length = norm(line.direction),
            distance = dot(offset, unit(line.direction));
          value =
            norm(sub(p, footToLine(p, line.origin, line.direction))) <= threshold &&
            (line.domain === 'line' || distance >= -threshold) &&
            (line.domain !== 'segment' || distance <= length + threshold);
          break;
        }
        case 'onPlane':
          value = onPlane(point(assertion.point), plane(assertion.plane));
          break;
        case 'coplanar': {
          const points = assertion.points.map(point),
            origin = points[0];
          let f: Frame | undefined;
          for (let i = 1; i < points.length && !f; i++)
            for (let j = i + 1; j < points.length && !f; j++) {
              try {
                f = frame(origin, points[i], points[j]);
              } catch (error) {
                if (!(error instanceof UndefinedGeometry) || error.reason !== 'degenerate_plane')
                  throw error;
              }
            }
          if (!f) undef('degenerate_plane');
          value = points.every((p) => onPlane(p, f));
          break;
        }
        case 'measurementEquals': {
          const measured = measurements[assertion.measurement];
          if (measured.status === 'undefined') undef('dependency_undefined');
          const result = evaluateGeometryScalar(
            assertion.expected,
            Object.fromEntries(
              spec.parameters.map((parameter) => [
                parameter.id,
                inputs.get(`parameter:${parameter.id}`)!,
              ]),
            ),
          );
          if (result.status === 'undefined')
            undef(result.reason === 'non_finite_result' ? 'non_finite_result' : 'scalar_undefined');
          value =
            Math.abs(finiteNumber(measured.value! - result.value)) <=
            (measured.unit === 'degree'
              ? ANGLE_TOLERANCE
              : tolerance(Math.max(Math.abs(measured.value!), Math.abs(result.value))));
          break;
        }
        case 'parallel':
        case 'perpendicular': {
          const a = required(assertion.a),
            b = required(assertion.b);
          const firstPlane = !!a.plane,
            secondPlane = !!b.plane;
          const u = firstPlane ? a.plane!().n : unit(a.linear!().direction),
            v = secondPlane ? b.plane!().n : unit(b.linear!().direction);
          const useDot = (assertion.kind === 'parallel') !== (firstPlane === secondPlane);
          value = (useDot ? Math.abs(dot(u, v)) : norm(cross(u, v))) <= DIRECTION_TOLERANCE;
          break;
        }
      }
      return { value, status: 'valid', reason: null };
    } catch (error) {
      if (!(error instanceof UndefinedGeometry)) throw error;
      return { value: null, status: 'undefined', reason: error.reason };
    }
  };
  const state = (): GeometryInputState => ({
    parameters: Object.fromEntries(
      spec.parameters.map((parameter) => [parameter.id, inputs.get(`parameter:${parameter.id}`)!]),
    ),
    freedoms: Object.fromEntries(
      [...bindings].map(([id, fields]) => [
        id,
        fields.length === 1 && fields[0].field === 'value'
          ? inputs.get(fields[0].key)!
          : Object.fromEntries(fields.map((binding) => [binding.field, inputs.get(binding.key)!])),
      ]),
    ),
  });
  const assertAlive = (): void => {
    if (disposed) throw new GeometryInputError('disposed');
  };
  const snapshot = (): GeometrySnapshot => {
    assertAlive();
    const objects: Record<string, GeometryObjectState> = {},
      measurements: Record<string, GeometryMeasurementState> = {},
      assertions: Record<string, GeometryAssertionState> = {};
    const diagnostics: GeometryDiagnostic[] = [];
    const diagnostic = (code: string, path: string) => {
      if (diagnostics.length < 32) diagnostics.push({ code, path });
    };
    spec.objects.forEach((object, index) => {
      const node = nodes.get(object.id)!;
      const value: { -readonly [K in keyof GeometryObjectState]: GeometryObjectState[K] } = {
        kind: object.kind,
        status: node.reason ? 'undefined' : 'valid',
        reason: node.reason,
        coordinates: null,
      };
      if (node.reason) diagnostic(node.reason, `$.spec.objects[${index}]`);
      else {
        if (node.point) value.coordinates = coords(node.point);
        if (node.linear) {
          const line = node.linear();
          value.origin = line.origin;
          value.direction = line.direction;
        }
        if (node.plane) value.frame = node.plane();
        if (node.circle) {
          value.coordinates = coords(node.circle.center);
          value.radius = node.circle.Radius();
        }
        if (object.kind === 'face' || object.kind === 'polygon') {
          value.vertices = object.vertices.map(point);
          value.vertexIds = [...object.vertices];
          value.frame = faceFrame(object.vertices.map(point));
        }
        if (object.kind === 'polyhedron') value.faces = [...object.faces];
        if (node.matrix) value.matrix = node.matrix().map((row) => [...row]);
      }
      objects[object.id] = value;
    });
    spec.measurements.forEach((measurement, index) => {
      const value = measure(measurement);
      measurements[measurement.id] = value;
      if (value.reason) diagnostic(value.reason, `$.spec.measurements[${index}]`);
    });
    spec.assertions.forEach((assertion, index) => {
      const value = assert(assertion, measurements);
      assertions[assertion.id] = value;
      if (value.reason || value.value === false)
        diagnostic(value.reason ?? 'assertion_failed', `$.spec.assertions[${index}]`);
    });
    return freeze({
      revision,
      valid: diagnostics.length === 0,
      inputs: state(),
      objects,
      measurements,
      assertions,
      diagnostics,
    });
  };
  let planarPresentation: GeometryPlanarPresentation | undefined;
  try {
    if (options.planar)
      planarPresentation = createPlanarPresentation({
        board,
        container: options.planar.container,
        spec,
        snapshot,
        assertAlive,
        refresh,
        elements: new Map(
          [...nodes].flatMap(([id, node]) => {
            const element = node.point ?? node.renderElement;
            return element ? [[id, element] as const] : [];
          }),
        ),
      });
  } catch (error) {
    disposeBoard(board);
    throw error;
  }
  return {
    ...(planarPresentation ? { planarPresentation } : {}),
    snapshot,
    applyInputs(patch) {
      assertAlive();
      record(patch);
      if (Object.keys(patch).some((key) => key !== 'parameters' && key !== 'freedoms'))
        throw new GeometryInputError('unknown_input');
      const changes = new Map<string, number>();
      const set = (key: string, value: unknown, range: GeometryRange): void => {
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < range.min ||
          value > range.max
        )
          throw new GeometryInputError('invalid_input');
        if (changes.has(key) && changes.get(key) !== value)
          throw new GeometryInputError('input_conflict');
        changes.set(key, value);
      };
      if (patch.parameters !== undefined) {
        record(patch.parameters);
        for (const [id, value] of Object.entries(patch.parameters)) {
          if (!spec.interaction.parameters.includes(id))
            throw new GeometryInputError('unknown_input');
          set(`parameter:${id}`, value, parameterRanges.get(id)!);
        }
      }
      if (patch.freedoms !== undefined) {
        record(patch.freedoms);
        for (const [id, value] of Object.entries(patch.freedoms)) {
          const fields = bindings.get(id);
          if (!fields) throw new GeometryInputError('unknown_input');
          if (fields.length === 1 && fields[0].field === 'value')
            set(fields[0].key, value, fields[0].range);
          else {
            record(value);
            if (
              Object.keys(value).length !== fields.length ||
              Object.keys(value).some((key) => !fields.some((field) => field.field === key))
            )
              throw new GeometryInputError('invalid_input');
            for (const field of fields) set(field.key, value[field.field], field.range);
          }
        }
      }
      const previous = inputs;
      inputs = new Map([...inputs, ...changes]);
      try {
        refresh();
      } catch (error) {
        inputs = previous;
        refresh();
        throw error;
      }
      revision++;
      return snapshot();
    },
    reset() {
      assertAlive();
      inputs = new Map(initial);
      refresh();
      revision++;
      return snapshot();
    },
    dispose() {
      if (!disposed) {
        planarPresentation?.dispose();
        disposed = true;
        disposeBoard(board);
      }
    },
  };
}

function validateClosedPolyhedron(faces: readonly (readonly string[])[]): void {
  const edges = new Map<string, { face: number; from: string; to: string }[]>();
  faces.forEach((vertices, face) =>
    vertices.forEach((from, index) => {
      const to = vertices[(index + 1) % vertices.length],
        key = [from, to].sort().join(':');
      const entries = edges.get(key) ?? [];
      entries.push({ face, from, to });
      edges.set(key, entries);
    }),
  );
  const neighbors = faces.map(() => new Set<number>());
  for (const entries of edges.values()) {
    if (
      entries.length !== 2 ||
      entries[0].from !== entries[1].to ||
      entries[0].to !== entries[1].from
    )
      undef('invalid_closed_polyhedron');
    neighbors[entries[0].face].add(entries[1].face);
    neighbors[entries[1].face].add(entries[0].face);
  }
  const connected = (allowed: Set<number>): boolean => {
    const visited = new Set<number>(),
      queue = [[...allowed][0]];
    while (queue.length) {
      const index = queue.pop()!;
      if (visited.has(index)) continue;
      visited.add(index);
      for (const next of neighbors[index]) if (allowed.has(next)) queue.push(next);
    }
    return visited.size === allowed.size;
  };
  if (!connected(new Set(faces.map((_, index) => index)))) undef('invalid_closed_polyhedron');
  for (const vertex of new Set(faces.flat())) {
    const incident = new Set(
      faces.flatMap((face, index) => (face.includes(vertex) ? [index] : [])),
    );
    if (!connected(incident)) undef('invalid_closed_polyhedron');
  }
}

export function evaluateGeometry(envelope: unknown): {
  readonly valid: boolean;
  readonly diagnostics: readonly GeometryDiagnostic[];
  readonly snapshot: GeometrySnapshot;
} {
  const engine = createGeometryEngine(envelope);
  try {
    const snapshot = engine.snapshot();
    return freeze({ valid: snapshot.valid, diagnostics: snapshot.diagnostics, snapshot });
  } finally {
    engine.dispose();
  }
}
