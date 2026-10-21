import {
  parseGeometryEnvelopeV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import type { GeometryMeasurementDisplay } from './geometry-diagram.js';
import type { ReachDeckModelJsonSchema } from './model-service-schemas.js';

/**
 * Static geometry diagrams ask the model only for static facts (constructions, labels,
 * measurements, assertions and right-angle marks). The host fills every interactive-only field
 * of the reach-science-kit/v1 envelope deterministically before the authoritative parser runs.
 */
export const GEOMETRY_DIAGRAM_PROMPT_VERSION = 'geometry-diagram/v4';

const idSchema = { type: 'string' } as const;
const numberSchema = { type: 'number' } as const;
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const colorSchema = {
  type: 'string',
  enum: ['ink', 'muted', 'accent', 'success', 'warning'],
} as const;
const lineStyleSchema = { type: 'string', enum: ['solid', 'dashed', 'dotted'] } as const;

type Fields = Record<string, unknown>;
/**
 * 每个条目是以 kind 为唯一键的对象（{"segment": {...}}）。模型网关会按字母序强制结构化输出的键
 * 顺序；若用扁平的 {id, kind, ...} 变体，字母序下只有 mirror 以 id 开头，模型一写 "id" 就被约束
 * 解码锁进 mirror。kind 作为唯一键时第一个键就决定变体，与键顺序无关。
 */
function variant(kind: string, fields: Fields, extras: Fields = {}): Record<string, unknown> {
  const properties = { id: idSchema, ...fields, ...extras };
  return {
    type: 'object',
    properties: {
      [kind]: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
    required: [kind],
    additionalProperties: false,
  };
}
const pointStyle = { label: nullableString, color: colorSchema, hidden: { type: 'boolean' } };
const lineStyle = { ...pointStyle, lineStyle: lineStyleSchema };
const measurementStyle = {
  label: nullableString,
  show: { type: 'string', enum: ['value', 'label', 'labelAndValue', 'none', 'hidden'] },
  decimals: { type: 'integer' },
};

const POINT_KINDS: Record<string, Fields> = {
  point: { x: numberSchema, y: numberSchema },
  midpoint: { a: idSchema, b: idSchema },
  footToLine: { point: idSchema, line: idSchema },
  pointOnLine: { line: idSchema, t: numberSchema },
  pointOnCircle: { circle: idSchema, angle: numberSchema },
  intersectLines: { line1: idSchema, line2: idSchema },
  intersectLineCircle: {
    line: idSchema,
    circle: idSchema,
    branch: { type: 'string', enum: ['lower', 'upper'] },
  },
  transformPoint: { point: idSchema, transform: idSchema },
};
const LINE_KINDS: Record<string, Fields> = {
  segment: { a: idSchema, b: idSchema },
  line: { a: idSchema, b: idSchema },
  ray: { a: idSchema, b: idSchema },
  parallelLine: { point: idSchema, line: idSchema },
  perpendicularLine: { point: idSchema, line: idSchema },
  circle: { center: idSchema, radius: numberSchema },
  polygon: { vertices: { type: 'array', items: idSchema } },
};
const TRANSFORM_KINDS: Record<string, Fields> = {
  translate: { dx: numberSchema, dy: numberSchema },
  rotate: { center: idSchema, angle: numberSchema },
  scale: { center: idSchema, factor: numberSchema },
  mirror: { line: idSchema },
};
const MEASUREMENT_KINDS: Record<string, Fields> = {
  distance: { a: idSchema, b: idSchema },
  threePointAngle: { a: idSchema, vertex: idSchema, b: idSchema },
  lineAngle: { line1: idSchema, line2: idSchema },
  pointLineDistance: { point: idSchema, line: idSchema },
};
const ASSERTION_KINDS: Record<string, Fields> = {
  perpendicular: { a: idSchema, b: idSchema },
  parallel: { a: idSchema, b: idSchema },
  onLine: { point: idSchema, line: idSchema },
  measurementEquals: { measurement: idSchema, expected: numberSchema },
};

export const GEOMETRY_DIAGRAM_SCHEMA: ReachDeckModelJsonSchema = {
  name: 'reach_deck_geometry_diagram',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      ariaLabel: { type: 'string' },
      units: { type: 'string', enum: ['unit', 'mm', 'cm', 'm', 'km'] },
      objects: {
        type: 'array',
        items: {
          anyOf: [
            ...Object.entries(POINT_KINDS).map(([kind, fields]) =>
              variant(kind, fields, pointStyle),
            ),
            ...Object.entries(LINE_KINDS).map(([kind, fields]) => variant(kind, fields, lineStyle)),
            ...Object.entries(TRANSFORM_KINDS).map(([kind, fields]) => variant(kind, fields)),
          ],
        },
      },
      measurements: {
        type: 'array',
        items: {
          anyOf: Object.entries(MEASUREMENT_KINDS).map(([kind, fields]) =>
            variant(kind, fields, measurementStyle),
          ),
        },
      },
      assertions: {
        type: 'array',
        items: {
          anyOf: Object.entries(ASSERTION_KINDS).map(([kind, fields]) => variant(kind, fields)),
        },
      },
      rightAngles: { type: 'array', items: idSchema },
    },
    required: ['ariaLabel', 'units', 'objects', 'measurements', 'assertions', 'rightAngles'],
    additionalProperties: false,
  },
};

export interface StaticGeometryDiagram {
  readonly envelope: GeometryEnvelopeV2;
  readonly measurementDisplay: Readonly<Record<string, GeometryMeasurementDisplay>>;
  /** Rewrites envelope paths in host/renderer diagnostics into the model's own field paths. */
  readonly explain: (message: string) => string;
}

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const POINT_STYLE_KEYS: ReadonlySet<string> = new Set(['label', 'color', 'hidden']);
const LINE_STYLE_KEYS: ReadonlySet<string> = new Set(['label', 'color', 'hidden', 'lineStyle']);
const MEASUREMENT_STYLE_KEYS: ReadonlySet<string> = new Set(['label', 'show', 'decimals']);

function fail(message: string): never {
  throw new Error(`Static geometry input invalid: ${message}`);
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if (value.length > maximum) fail(`${path} has more than ${maximum} entries`);
  return value.map(unkeyByKind);
}

/** 把模型输出的 {"segment": {...}} 还原为 {kind: "segment", ...}；已是扁平形状的条目原样返回。 */
function unkeyByKind(entry: unknown): unknown {
  if (!isRecord(entry) || Object.hasOwn(entry, 'kind')) return entry;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || !isRecord(entry[keys[0]!])) return entry;
  return { ...(entry[keys[0]!] as RecordValue), kind: keys[0] };
}

const keyByKind = (entries: unknown) =>
  (entries as RecordValue[]).map(({ kind, ...fields }) => ({ [String(kind)]: fields }));

/** 把扁平形状的示例输出转换成发给模型的 kind 键形状（见 {@link variant}）。 */
export function toModelGeometryOutput(
  output: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...output,
    objects: keyByKind(output.objects),
    measurements: keyByKind(output.measurements),
    assertions: keyByKind(output.assertions),
  };
}

/** Construction fields are required; presentation fields are optional with host defaults. */
function exactFields(
  value: RecordValue,
  fields: Fields,
  optional: ReadonlySet<string>,
  path: string,
) {
  const required = ['id', 'kind', ...Object.keys(fields)];
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.has(key))
      fail(`${path}.${key} is not a field of kind ${String(value.kind)}`);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      fail(`${path}.${key} is required for kind ${String(value.kind)}`);
}

const label = (value: unknown, path: string): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${path} must be a string or null`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Converts the model's static geometry object into a complete V2 envelope and parses it with the
 * authoritative contract parser. Thrown errors describe paths in the model's own input shape.
 */
export function buildStaticGeometryDiagram(input: unknown): StaticGeometryDiagram {
  if (!isRecord(input)) fail('root must be an object');
  const expected = ['ariaLabel', 'units', 'objects', 'measurements', 'assertions', 'rightAngles'];
  for (const key of Object.keys(input))
    if (!expected.includes(key)) fail(`unknown root field ${key}`);
  if (typeof input.ariaLabel !== 'string' || !input.ariaLabel.trim())
    fail('ariaLabel must be a non-empty string');
  const units = input.units ?? 'unit';
  const objects: RecordValue[] = [];
  const presentationObjects: RecordValue[] = [];
  const presentationObjectSource: number[] = [];
  array(input.objects, 'objects', 128).forEach((entry, index) => {
    const path = `objects[${index}]`;
    if (!isRecord(entry) || typeof entry.kind !== 'string') fail(`${path} must have a kind`);
    const kind = entry.kind;
    const fields = POINT_KINDS[kind] ?? LINE_KINDS[kind] ?? TRANSFORM_KINDS[kind];
    if (!fields) fail(`${path}.kind ${kind} is not supported in static diagrams`);
    const transform = Object.hasOwn(TRANSFORM_KINDS, kind);
    const styleKeys = transform
      ? new Set<string>()
      : Object.hasOwn(POINT_KINDS, kind)
        ? POINT_STYLE_KEYS
        : LINE_STYLE_KEYS;
    exactFields(entry, fields, styleKeys, path);
    const object: RecordValue = { id: entry.id, kind };
    for (const key of Object.keys(fields)) object[key] = entry[key];
    objects.push(object);
    if (transform) return;
    const presentation: RecordValue = { object: entry.id };
    const text = label(entry.label, `${path}.label`);
    if (text !== undefined) presentation.label = text;
    if (entry.color !== undefined && entry.color !== 'ink') presentation.colorToken = entry.color;
    if (entry.lineStyle !== undefined && entry.lineStyle !== 'solid')
      presentation.lineStyle = entry.lineStyle;
    if (entry.hidden === true) presentation.visible = false;
    presentationObjects.push(presentation);
    presentationObjectSource.push(index);
  });
  const measurements: RecordValue[] = [];
  const presentationMeasurements: RecordValue[] = [];
  const measurementDisplay: Record<string, GeometryMeasurementDisplay> = {};
  array(input.measurements, 'measurements', 24).forEach((entry, index) => {
    const path = `measurements[${index}]`;
    if (!isRecord(entry) || typeof entry.kind !== 'string') fail(`${path} must have a kind`);
    const fields = MEASUREMENT_KINDS[entry.kind];
    if (!fields) fail(`${path}.kind ${entry.kind} is not supported in static diagrams`);
    exactFields(entry, fields, MEASUREMENT_STYLE_KEYS, path);
    const measurement: RecordValue = { id: entry.id, kind: entry.kind };
    for (const key of Object.keys(fields)) measurement[key] = entry[key];
    measurements.push(measurement);
    const text = label(entry.label, `${path}.label`);
    const show = entry.show ?? (text === undefined ? 'value' : 'labelAndValue');
    if (!['value', 'label', 'labelAndValue', 'none', 'hidden'].includes(show as string))
      fail(`${path}.show must be value, label, labelAndValue, none or hidden`);
    const presentation: RecordValue = { measurement: entry.id };
    if (text !== undefined) presentation.label = text;
    else if (show === 'label' || show === 'labelAndValue')
      fail(`${path}.show ${String(show)} requires a non-empty label`);
    const decimals = entry.decimals ?? 2;
    if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 4)
      fail(`${path}.decimals must be an integer 0..4`);
    presentation.decimals = decimals;
    if (show === 'hidden') presentation.visible = false;
    else if (typeof entry.id === 'string')
      measurementDisplay[entry.id] = show as GeometryMeasurementDisplay;
    presentationMeasurements.push(presentation);
  });
  const assertions = array(input.assertions, 'assertions', 32).map((entry, index) => {
    const path = `assertions[${index}]`;
    if (!isRecord(entry) || typeof entry.kind !== 'string') fail(`${path} must have a kind`);
    const fields = ASSERTION_KINDS[entry.kind];
    if (!fields) fail(`${path}.kind ${entry.kind} is not supported in static diagrams`);
    exactFields(entry, fields, new Set(['id', 'kind']), path);
    const assertion: RecordValue = { id: entry.id, kind: entry.kind };
    for (const key of Object.keys(fields)) assertion[key] = entry[key];
    return assertion;
  });
  const taken = new Set(
    [...objects, ...measurements, ...assertions].map((entry) => String(entry.id)),
  );
  const rightAngles = array(input.rightAngles, 'rightAngles', 24).map((measurement, index) => {
    if (typeof measurement !== 'string') fail(`rightAngles[${index}] must be a measurement id`);
    const target = measurements.find((entry) => entry.id === measurement);
    if (!target) fail(`rightAngles[${index}] references unknown measurement ${measurement}`);
    if (target.kind !== 'threePointAngle' && target.kind !== 'lineAngle')
      fail(`rightAngles[${index}] must reference a threePointAngle or lineAngle measurement`);
    let id = `rightAngle${index + 1}`;
    while (taken.has(id)) id += 'x';
    taken.add(id);
    return { id, measurement };
  });
  // Right-angle marks render only for visible angle measurements; keep them visible but textless
  // unless the model asked for text explicitly.
  for (const { measurement } of rightAngles) {
    const presentation = presentationMeasurements.find(
      (entry) => entry.measurement === measurement,
    );
    if (presentation && presentation.visible === false) {
      delete presentation.visible;
      measurementDisplay[measurement] = 'none';
    } else if (!presentation) {
      presentationMeasurements.push({ measurement });
      measurementDisplay[measurement] = 'none';
    }
  }
  const envelope = {
    schemaVersion: 'reach-science-kit/v1',
    kitId: 'euclidean-geometry-2d',
    kitVersion: 2,
    spec: {
      schemaVersion: 'reach-euclidean-geometry/v2',
      dimension: 2,
      ariaLabel: input.ariaLabel.trim().slice(0, 256),
      units,
      parameters: [],
      objects,
      measurements,
      relations: [],
      assertions,
      presentation: {
        objects: presentationObjects,
        measurements: presentationMeasurements,
        relations: [],
        groups: [],
        rightAngles,
        // Static diagrams are fitted to the computed geometry by the renderer; this camera only
        // satisfies the envelope contract.
        camera: { kind: 'planar', bounds: [-1, -1, 1, 1] },
      },
      interaction: {
        parameters: [],
        freedoms: [],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
        exploration: {
          objectKinds: [],
          measurementKinds: [],
          relationKinds: [],
          referenceableObjects: [],
          limits: { objects: 0, measurements: 0, relations: 0 },
          feedback: 'hidden',
        },
      },
    },
  };
  const explain = (message: string) =>
    message
      .replace(/\$\.spec\.presentation\.objects\[(\d+)\]/g, (_, index: string) => {
        const source = presentationObjectSource[Number(index)];
        return source === undefined ? `objects (style ${index})` : `objects[${source}]`;
      })
      .replace(/\$\.spec\.presentation\.measurements\[(\d+)\]/g, 'measurements[$1]')
      .replace(/\$\.spec\.presentation\.rightAngles\[(\d+)\]/g, 'rightAngles[$1]')
      .replace(/presentation\.rightAngles\[(\d+)\]/g, 'rightAngles[$1]')
      .replace(/\$\.spec\.(objects|measurements|assertions)/g, '$1')
      .replace(/\$\.spec\.ariaLabel/g, 'ariaLabel')
      .replace(/\$\.spec\.units/g, 'units');
  try {
    return {
      envelope: parseGeometryEnvelopeV2(envelope).envelope,
      measurementDisplay,
      explain,
    };
  } catch (error) {
    fail(explain(error instanceof Error ? error.message : String(error)));
  }
}

/** A static example in the flat input shape; {@link toModelGeometryOutput} gives the model shape. */
export interface StaticGeometryExample {
  readonly id: string;
  readonly brief: string;
  readonly terms: readonly string[];
  readonly output: Readonly<Record<string, unknown>>;
}

const pt = (id: string, x: number, y: number, text: string | null = id) => ({
  id,
  kind: 'point',
  x,
  y,
  label: text,
  color: 'ink',
  hidden: false,
});
const seg = (id: string, a: string, b: string, text: string | null = null, color = 'ink') => ({
  id,
  kind: 'segment',
  a,
  b,
  label: text,
  color,
  lineStyle: 'solid',
  hidden: false,
});
const tri = (id: string, vertices: string[]) => ({
  id,
  kind: 'polygon',
  vertices,
  label: null,
  color: 'ink',
  lineStyle: 'solid',
  hidden: false,
});
const angle = (
  id: string,
  a: string,
  vertex: string,
  b: string,
  show: string,
  text: string | null = null,
  decimals = 0,
) => ({ id, kind: 'threePointAngle', a, vertex, b, label: text, show, decimals });

export const STATIC_GEOMETRY_EXAMPLES: readonly StaticGeometryExample[] = Object.freeze([
  {
    id: 'static-right-triangle',
    brief:
      'Right triangle ABC with the right angle at C; mark angle A; name the sides relative to angle A.',
    terms: [
      '直角',
      '三角',
      '斜边',
      '对边',
      '邻边',
      '锐角',
      'sin',
      'cos',
      'tan',
      '正弦',
      '余弦',
      '正切',
      '勾股',
      'right',
      'triangle',
      'hypotenuse',
      'trig',
    ],
    output: {
      ariaLabel: '直角三角形 ABC，∠C 为直角，标出∠A 及其对边、邻边和斜边',
      units: 'unit',
      objects: [
        pt('C', 0, 0),
        pt('B', 4, 0),
        pt('A', 0, 3),
        tri('ABC', ['A', 'B', 'C']),
        seg('CB', 'C', 'B', '对边'),
        seg('CA', 'C', 'A', '邻边'),
        seg('AB', 'A', 'B', '斜边', 'accent'),
      ],
      measurements: [
        angle('angleC', 'A', 'C', 'B', 'none'),
        angle('angleA', 'C', 'A', 'B', 'none'),
      ],
      assertions: [{ id: 'rightAtC', kind: 'perpendicular', a: 'CA', b: 'CB' }],
      rightAngles: ['angleC'],
    },
  },
  {
    id: 'static-altitude-foot',
    brief:
      'Triangle ABC with the altitude from C to AB constructed by footToLine; mark the foot H.',
    terms: [
      '高',
      '垂足',
      '垂线',
      '垂直',
      '距离',
      'altitude',
      'height',
      'perpendicular',
      'foot',
      'distance',
    ],
    output: {
      ariaLabel: '三角形 ABC 与 AB 边上的高 CH',
      units: 'unit',
      objects: [
        pt('A', 0, 0),
        pt('B', 6, 0),
        pt('C', 2, 3.5),
        tri('ABC', ['A', 'B', 'C']),
        {
          id: 'H',
          kind: 'footToLine',
          point: 'C',
          line: 'AB',
          label: 'H',
          color: 'accent',
          hidden: false,
        },
        seg('AB', 'A', 'B'),
        { ...seg('CH', 'C', 'H', 'h', 'accent'), lineStyle: 'dashed' },
      ],
      measurements: [
        angle('angleH', 'C', 'H', 'B', 'none'),
        { id: 'height', kind: 'distance', a: 'C', b: 'H', label: null, show: 'none', decimals: 1 },
      ],
      assertions: [{ id: 'altitude', kind: 'perpendicular', a: 'CH', b: 'AB' }],
      rightAngles: ['angleH'],
    },
  },
  {
    id: 'static-measured-angle',
    brief: 'Triangle ABC with the host-computed size of angle A written beside its arc.',
    terms: ['角', '角度', '度数', '内角', 'angle', 'degree'],
    output: {
      ariaLabel: '三角形 ABC，标出∠A 的度数',
      units: 'unit',
      objects: [pt('A', 0, 0), pt('B', 6, 0), pt('C', 2, 3.5), tri('ABC', ['A', 'B', 'C'])],
      measurements: [angle('angleA', 'B', 'A', 'C', 'value', null, 1)],
      assertions: [],
      rightAngles: [],
    },
  },
]);

/** Deterministic relevance ranking; the right-triangle example wins ties for triangle/angle briefs. */
export function selectStaticGeometryExamples(
  text: string,
  count = 2,
): readonly StaticGeometryExample[] {
  const haystack = text.toLowerCase();
  const scored = STATIC_GEOMETRY_EXAMPLES.map((example, index) => ({
    example,
    index,
    score: example.terms.filter((term) => haystack.includes(term.toLowerCase())).length,
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, count).map((entry) => entry.example);
}

export const GEOMETRY_DIAGRAM_PROMPT = [
  'Produce one static planar Euclidean geometry diagram as the JSON object defined by the response schema. It is rendered by the host geometry engine; you never supply coordinates of labels, arcs, marks, SVG or HTML.',
  'Each entry of objects, measurements and assertions is a single-key object whose key is its kind, e.g. {"segment":{"id":"AB","a":"A","b":"B",...}}; the inner object holds that kind\'s fields.',
  'objects may only reference ids declared in objects (no cycles). ids match ^[A-Za-z][A-Za-z0-9_]{0,39}$ and are unique across objects, measurements and assertions. Vertex names and labels must follow the brief and invariants exactly (for example if the brief says the right angle is at C, the vertex labelled C carries the right angle).',
  'Draw sides as segment objects (a polygon adds only a light fill). Put side names or given lengths in the segment label (e.g. "斜边", "10", "?"). Put vertex names in point labels. Use hidden:true for helper objects that must not be drawn.',
  'A right angle must be guaranteed by construction, never by approximate coordinates: use axis-aligned exact coordinates, perpendicularLine, or footToLine, and add a perpendicular assertion on the two sides. Declare the mark by listing its threePointAngle (vertex = right-angle vertex) in rightAngles; use show "none" for that measurement.',
  'Use threePointAngle measurements for angle arcs (arc at the vertex, text beside it). show: "none" draws only the arc, "label" writes the label (e.g. "α"), "value" writes the host-computed degrees, "labelAndValue" writes "label = value", "hidden" computes without drawing. Use distance measurements with show "value" to write host-computed lengths beside a side; never type numbers that the engine can compute and never invent numerical evidence. units: "unit" (no unit text) unless the source states a unit.',
  'Choose coordinates so that numbers stated in the brief are exact (e.g. sides 6, 8, 10). angles for pointOnCircle/rotate are radians. Keep the figure uncluttered: at most about 12 visible objects and 4 visible measurement texts.',
  'Every assertion must hold exactly; the host checks assertions and right angles and rejects the output otherwise.',
].join('\n');
