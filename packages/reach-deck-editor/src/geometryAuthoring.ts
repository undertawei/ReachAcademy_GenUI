import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  geometryAuthoringExplorationPolicyV2,
  parseGeometryEnvelopeV2,
  validateGeometryAuxiliaryStateV2,
  type GeometryAuthoringBindingsV2,
  type GeometryAuxiliaryStateV2,
  type GeometryEnvelopeV2,
  type GeometryExplorationPolicyV2,
  type GeometryRelationPresentationV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import type {
  GeometryCamera,
  GeometryFreedom,
  GeometryMeasurement,
  GeometryObject,
  GeometryPresentation,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import { validateGeometryCamera } from '@reachany/reach-deck-dsl/euclidean-geometry';

export const GEOMETRY_AUTHORED_SNAPSHOT_SCHEMA_VERSION =
  'reach-geometry-authored-snapshot/v1' as const;
const MARKER_SELECTOR = 'script[data-reach-science-kit]';
const SNAPSHOT_SELECTOR = 'script[data-reach-geometry-snapshot]';
const INSTANCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BASE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export type GeometryAuthoringCategory =
  | 'objects'
  | 'measurements'
  | 'relations'
  | 'parameters'
  | 'freedoms';

/** Structural mirror of the Player bridge proposal, kept local so editor builds do not depend on dist order. */
export interface GeometryAuthoringEditProposal {
  readonly schemaVersion: 'reach-geometry-edit-proposal/v1';
  readonly pageId: string;
  readonly sourceRevision: number;
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly envelope: GeometryEnvelopeV2;
  readonly state: Record<string, unknown>;
  readonly wireSequence: number;
}

export interface GeometryAuthoredSnapshotV1 {
  readonly schemaVersion: typeof GEOMETRY_AUTHORED_SNAPSHOT_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly inputs: {
    readonly parameters: Readonly<Record<string, number>>;
    readonly freedoms: Readonly<Record<string, number | Readonly<Record<string, number>>>>;
  };
  readonly camera: GeometryCamera;
}

export interface GeometryAuthoringInstance {
  readonly instanceId: string;
  readonly envelope: GeometryEnvelopeV2;
  readonly fingerprint: string;
  readonly editable: boolean;
  readonly snapshot?: GeometryAuthoredSnapshotV1;
}

export interface GeometryAuthoringInspection {
  readonly instances: readonly GeometryAuthoringInstance[];
  readonly editable: boolean;
  readonly hasGeometryV2: boolean;
}

export class GeometryAuthoringError extends Error {
  constructor(
    readonly code:
      | 'bad_marker'
      | 'duplicate_instance'
      | 'external_reference'
      | 'invalid_value'
      | 'invalid_proposal'
      | 'invalid_snapshot'
      | 'not_found'
      | 'read_only'
      | 'stale_fingerprint'
      | 'stale_revision'
      | 'unsupported_initial_value',
    message: string,
  ) {
    super(message);
    this.name = 'GeometryAuthoringError';
  }
}

type InteractivePage = Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }>;

interface ParsedMarker {
  marker: HTMLScriptElement;
  instanceId: string;
  envelope: GeometryEnvelopeV2;
  fingerprint: string;
  snapshotMarker?: HTMLScriptElement;
  snapshot?: GeometryAuthoredSnapshotV1;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function geometryEnvelopeFingerprint(envelope: GeometryEnvelopeV2): string {
  return bytesToHex(sha256(encoder.encode(canonicalJson(envelope))));
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function serializeDocument(document: Document): string {
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function immediatelyFollows(snapshot: Element, geometryMarker: Element): boolean {
  return snapshot.previousSibling === geometryMarker;
}

function assertJsonScript(marker: Element, attribute: string): asserts marker is HTMLScriptElement {
  if (
    marker.tagName.toLowerCase() !== 'script' ||
    (marker.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json' ||
    !INSTANCE_ID_PATTERN.test(marker.getAttribute(attribute)?.trim() ?? '')
  ) {
    throw new GeometryAuthoringError('bad_marker', `Invalid ${attribute} marker.`);
  }
}

function parseJsonMarker(marker: HTMLScriptElement, label: string): unknown {
  try {
    return JSON.parse(marker.textContent ?? '');
  } catch {
    throw new GeometryAuthoringError('bad_marker', `${label} must contain strict JSON.`);
  }
}

function parseFiniteRecord(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!plainRecord(value)) return undefined;
  if (
    Object.entries(value).some(
      ([key, entry]) =>
        !BASE_ID_PATTERN.test(key) || typeof entry !== 'number' || !Number.isFinite(entry),
    )
  ) {
    return undefined;
  }
  return value as Readonly<Record<string, number>>;
}

function parseFreedomValues(
  value: unknown,
): Readonly<Record<string, number | Readonly<Record<string, number>>>> | undefined {
  if (!plainRecord(value)) return undefined;
  const parsed: Record<string, number | Readonly<Record<string, number>>> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!BASE_ID_PATTERN.test(id)) return undefined;
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      parsed[id] = entry;
      continue;
    }
    const coordinates = parseFiniteRecord(entry);
    if (coordinates === undefined) return undefined;
    parsed[id] = coordinates;
  }
  return parsed;
}

function parseCamera(value: unknown): GeometryCamera | undefined {
  if (!plainRecord(value)) return undefined;
  if (
    value.kind === 'planar' &&
    exactKeys(value, ['kind', 'bounds']) &&
    Array.isArray(value.bounds) &&
    value.bounds.length === 4 &&
    value.bounds.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    value.bounds[2] > value.bounds[0] &&
    value.bounds[3] > value.bounds[1]
  ) {
    return value as unknown as GeometryCamera;
  }
  if (
    value.kind === 'spatial' &&
    exactKeys(value, ['kind', 'projection', 'position', 'target', 'up', 'zoom']) &&
    (value.projection === 'orthographic' || value.projection === 'perspective') &&
    [value.position, value.target, value.up].every(
      (tuple) =>
        Array.isArray(tuple) &&
        tuple.length === 3 &&
        tuple.every((entry) => typeof entry === 'number' && Number.isFinite(entry)),
    ) &&
    typeof value.zoom === 'number' &&
    Number.isFinite(value.zoom) &&
    value.zoom > 0
  ) {
    return value as unknown as GeometryCamera;
  }
  return undefined;
}

function validSnapshotFreedomValue(
  freedom: GeometryFreedom,
  value: number | Readonly<Record<string, number>>,
): boolean {
  if (freedom.kind === 'line' || freedom.kind === 'circle') {
    return typeof value === 'number' && valueInRange(value, freedom.range);
  }
  if (!plainRecord(value)) return false;
  if (freedom.kind === 'freePoint') {
    return (
      exactKeys(value, ['x', 'y']) &&
      typeof value.x === 'number' &&
      typeof value.y === 'number' &&
      valueInRange(value.x, freedom.x) &&
      valueInRange(value.y, freedom.y)
    );
  }
  if (freedom.kind === 'plane') {
    return (
      exactKeys(value, ['u', 'v']) &&
      typeof value.u === 'number' &&
      typeof value.v === 'number' &&
      valueInRange(value.u, freedom.u) &&
      valueInRange(value.v, freedom.v)
    );
  }
  if (!('ranges' in freedom)) return false;
  const ranges = new Map(freedom.ranges.map((range) => [range.axis, range] as const));
  return (
    exactKeys(value, [...ranges.keys()]) &&
    [...ranges].every(
      ([axis, range]) => typeof value[axis] === 'number' && valueInRange(value[axis], range),
    )
  );
}

function parseAuthoredSnapshot(
  value: unknown,
  instanceId: string,
  envelope: GeometryEnvelopeV2,
  fingerprint: string,
): GeometryAuthoredSnapshotV1 {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'instanceId', 'fingerprint', 'inputs', 'camera'])
  ) {
    throw new GeometryAuthoringError(
      'invalid_snapshot',
      'Authored geometry snapshot shape is invalid.',
    );
  }
  if (
    value.schemaVersion !== GEOMETRY_AUTHORED_SNAPSHOT_SCHEMA_VERSION ||
    value.instanceId !== instanceId ||
    value.fingerprint !== fingerprint ||
    !FINGERPRINT_PATTERN.test(String(value.fingerprint)) ||
    !plainRecord(value.inputs) ||
    !exactKeys(value.inputs, ['parameters', 'freedoms'])
  ) {
    throw new GeometryAuthoringError(
      'invalid_snapshot',
      'Authored geometry snapshot identity is invalid.',
    );
  }
  const parameters = parseFiniteRecord(value.inputs.parameters);
  const freedoms = parseFreedomValues(value.inputs.freedoms);
  const camera = parseCamera(value.camera);
  if (parameters === undefined || freedoms === undefined || camera === undefined) {
    throw new GeometryAuthoringError(
      'invalid_snapshot',
      'Authored geometry snapshot values are invalid.',
    );
  }
  const bindings = envelope.spec.authoring;
  const expectedParameters = [...envelope.spec.interaction.parameters].sort();
  const expectedFreedoms = envelope.spec.interaction.freedoms.map(({ id }) => id).sort();
  const parameterById = new Map(
    envelope.spec.parameters.map((parameter) => [parameter.id, parameter]),
  );
  const freedomById = new Map(
    envelope.spec.interaction.freedoms.map((freedom) => [freedom.id, freedom]),
  );
  let cameraValid = true;
  try {
    validateGeometryCamera(camera, envelope.spec.dimension);
  } catch {
    cameraValid = false;
  }
  if (
    bindings === undefined ||
    canonicalJson(Object.keys(parameters).sort()) !== canonicalJson(expectedParameters) ||
    canonicalJson(Object.keys(freedoms).sort()) !== canonicalJson(expectedFreedoms) ||
    Object.entries(parameters).some(([id, value]) => {
      const parameter = parameterById.get(id);
      return parameter === undefined || !valueInRange(value, parameter);
    }) ||
    Object.entries(freedoms).some(([id, value]) => {
      const freedom = freedomById.get(id);
      return freedom === undefined || !validSnapshotFreedomValue(freedom, value);
    }) ||
    !cameraValid ||
    encoder.encode(JSON.stringify(value)).byteLength > SNAPSHOT_MAX_BYTES
  ) {
    throw new GeometryAuthoringError(
      'invalid_snapshot',
      'Authored geometry snapshot exceeds its bindings.',
    );
  }
  return value as unknown as GeometryAuthoredSnapshotV1;
}

function parseMarkers(documentHtml: string): { document: Document; markers: ParsedMarker[] } {
  const document = new DOMParser().parseFromString(documentHtml, 'text/html');
  const snapshotMarkers = [...document.querySelectorAll(SNAPSHOT_SELECTOR)];
  const snapshotsByInstance = new Map<string, HTMLScriptElement>();
  for (const marker of snapshotMarkers) {
    assertJsonScript(marker, 'data-reach-geometry-snapshot');
    const instanceId = marker.getAttribute('data-reach-geometry-snapshot')!.trim();
    if (snapshotsByInstance.has(instanceId)) {
      throw new GeometryAuthoringError(
        'duplicate_instance',
        'Geometry snapshot ids must be unique.',
      );
    }
    snapshotsByInstance.set(instanceId, marker);
  }

  const seen = new Set<string>();
  const markers: ParsedMarker[] = [];
  for (const candidate of document.querySelectorAll(MARKER_SELECTOR)) {
    assertJsonScript(candidate, 'data-reach-science-kit');
    const instanceId = candidate.getAttribute('data-reach-science-kit')!.trim();
    if (seen.has(instanceId)) {
      throw new GeometryAuthoringError(
        'duplicate_instance',
        'Science kit instance ids must be unique.',
      );
    }
    seen.add(instanceId);
    const value = parseJsonMarker(candidate, 'Science kit marker');
    if (
      !plainRecord(value) ||
      value.schemaVersion !== 'reach-science-kit/v1' ||
      value.kitVersion !== 2 ||
      (value.kitId !== 'euclidean-geometry-2d' && value.kitId !== 'euclidean-geometry-3d')
    ) {
      continue;
    }
    const envelope = parseGeometryEnvelopeV2(value).envelope;
    const fingerprint = geometryEnvelopeFingerprint(envelope);
    const snapshotMarker = snapshotsByInstance.get(instanceId);
    if (snapshotMarker !== undefined) {
      if (!immediatelyFollows(snapshotMarker, candidate)) {
        throw new GeometryAuthoringError(
          'invalid_snapshot',
          'Geometry snapshot must immediately follow its geometry marker.',
        );
      }
    }
    const snapshot =
      snapshotMarker === undefined
        ? undefined
        : parseAuthoredSnapshot(
            parseJsonMarker(snapshotMarker, 'Geometry snapshot marker'),
            instanceId,
            envelope,
            fingerprint,
          );
    markers.push({
      marker: candidate,
      instanceId,
      envelope,
      fingerprint,
      snapshotMarker,
      snapshot,
    });
  }
  for (const instanceId of snapshotsByInstance.keys()) {
    if (!markers.some((marker) => marker.instanceId === instanceId)) {
      throw new GeometryAuthoringError(
        'invalid_snapshot',
        'Geometry snapshot has no v2 geometry marker.',
      );
    }
  }
  return { document, markers };
}

export function inspectGeometryAuthoring(documentHtml: string): GeometryAuthoringInspection {
  const { markers } = parseMarkers(documentHtml);
  const instances = markers.map(
    ({ instanceId, envelope, fingerprint, snapshot }): GeometryAuthoringInstance => ({
      instanceId,
      envelope,
      fingerprint,
      editable: envelope.spec.authoring !== undefined,
      snapshot,
    }),
  );
  return {
    instances,
    hasGeometryV2: instances.length > 0,
    editable: instances.some((instance) => instance.editable),
  };
}

function markerFor(markers: readonly ParsedMarker[], instanceId: string): ParsedMarker {
  const matches = markers.filter((entry) => entry.instanceId === instanceId);
  if (matches.length !== 1) {
    throw new GeometryAuthoringError(
      'not_found',
      'Geometry marker identity is missing or ambiguous.',
    );
  }
  return matches[0]!;
}

function writeSnapshot(
  parsed: { document: Document },
  marker: ParsedMarker,
  snapshot: GeometryAuthoredSnapshotV1,
): void {
  let snapshotMarker = marker.snapshotMarker;
  if (snapshotMarker === undefined) {
    snapshotMarker = parsed.document.createElement('script');
    snapshotMarker.type = 'application/json';
    snapshotMarker.setAttribute('data-reach-geometry-snapshot', marker.instanceId);
    marker.marker.after(snapshotMarker);
  }
  snapshotMarker.textContent = safeInlineJson(snapshot);
}

function replaceEnvelope(marker: ParsedMarker, envelope: GeometryEnvelopeV2): void {
  marker.marker.textContent = safeInlineJson(parseGeometryEnvelopeV2(envelope).envelope);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function allocateAuthoredIds(
  auxiliary: GeometryAuxiliaryStateV2,
  envelope: GeometryEnvelopeV2,
): ReadonlyMap<string, string> {
  const used = new Set<string>([
    ...envelope.spec.parameters.map(({ id }) => id),
    ...envelope.spec.objects.map(({ id }) => id),
    ...envelope.spec.measurements.map(({ id }) => id),
    ...envelope.spec.relations.map(({ id }) => id),
    ...envelope.spec.interaction.freedoms.map(({ id }) => id),
  ]);
  const mapping = new Map<string, string>();
  const ids = [
    ...auxiliary.objects.map(({ id }) => id),
    ...auxiliary.measurements.map(({ id }) => id),
    ...auxiliary.relations.map(({ id }) => id),
    ...auxiliary.freedoms.map(({ id }) => id),
  ];
  for (const learnerId of ids) {
    const stem = `A_${learnerId.slice(2)}`.slice(0, 36);
    let authoredId = stem;
    let suffix = 2;
    while (used.has(authoredId)) {
      authoredId = `${stem.slice(0, 39 - String(suffix).length)}_${suffix}`;
      suffix += 1;
    }
    used.add(authoredId);
    mapping.set(learnerId, authoredId);
  }
  return mapping;
}

function remapId(mapping: ReadonlyMap<string, string>, id: string): string {
  return mapping.get(id) ?? id;
}

function remapObject(object: GeometryObject, mapping: ReadonlyMap<string, string>): GeometryObject {
  const mapped = { ...object, id: remapId(mapping, object.id) } as Record<string, unknown>;
  const referenceFields = [
    'a',
    'b',
    'point',
    'line',
    'plane',
    'circle',
    'center',
    'origin',
    'uPoint',
    'vPoint',
    'line1',
    'line2',
    'plane1',
    'plane2',
  ];
  for (const field of referenceFields) {
    if (typeof mapped[field] === 'string')
      mapped[field] = remapId(mapping, mapped[field] as string);
  }
  if (Array.isArray(mapped.vertices)) {
    mapped.vertices = mapped.vertices.map((id) => remapId(mapping, String(id)));
  }
  if (Array.isArray(mapped.faces)) {
    mapped.faces = mapped.faces.map((id) => remapId(mapping, String(id)));
  }
  return mapped as unknown as GeometryObject;
}

function remapDefinition<T extends { readonly id: string }>(
  definition: T,
  mapping: ReadonlyMap<string, string>,
): T {
  const mapped = { ...definition, id: remapId(mapping, definition.id) } as Record<string, unknown>;
  for (const key of ['a', 'b', 'point', 'line', 'segment', 'plane', 'line1', 'line2']) {
    if (typeof mapped[key] === 'string') mapped[key] = remapId(mapping, mapped[key] as string);
  }
  return mapped as unknown as T;
}

function evaluateInitialScalar(scalar: unknown, parameters: ReadonlyMap<string, number>): number {
  if (typeof scalar === 'number' && Number.isFinite(scalar)) return scalar;
  if (!plainRecord(scalar)) {
    throw new GeometryAuthoringError('invalid_snapshot', 'Geometry initial scalar is invalid.');
  }
  if (exactKeys(scalar, ['parameter']) && typeof scalar.parameter === 'string') {
    const value = parameters.get(scalar.parameter);
    if (value === undefined) {
      throw new GeometryAuthoringError(
        'invalid_snapshot',
        'Geometry initial parameter is missing.',
      );
    }
    return value;
  }
  if (
    typeof scalar.op !== 'string' ||
    !Array.isArray(scalar.args) ||
    !['add', 'sub', 'mul', 'div', 'pow', 'neg', 'sqrt', 'sin', 'cos'].includes(scalar.op)
  ) {
    throw new GeometryAuthoringError('invalid_snapshot', 'Geometry initial expression is invalid.');
  }
  const args = scalar.args.map((entry) => evaluateInitialScalar(entry, parameters));
  let value: number;
  switch (scalar.op) {
    case 'add':
      value = args[0]! + args[1]!;
      break;
    case 'sub':
      value = args[0]! - args[1]!;
      break;
    case 'mul':
      value = args[0]! * args[1]!;
      break;
    case 'div':
      value = args[0]! / args[1]!;
      break;
    case 'pow':
      value = Math.pow(args[0]!, args[1]!);
      break;
    case 'neg':
      value = -args[0]!;
      break;
    case 'sqrt':
      value = Math.sqrt(args[0]!);
      break;
    case 'sin':
      value = Math.sin(args[0]!);
      break;
    case 'cos':
      value = Math.cos(args[0]!);
      break;
    default:
      throw new GeometryAuthoringError(
        'invalid_snapshot',
        'Geometry initial expression is invalid.',
      );
  }
  if (!Number.isFinite(value)) {
    throw new GeometryAuthoringError(
      'invalid_snapshot',
      'Geometry initial expression is undefined.',
    );
  }
  return value;
}

function freedomInitial(
  envelope: GeometryEnvelopeV2,
  freedom: GeometryFreedom,
  parameters: ReadonlyMap<string, number>,
): number | Readonly<Record<string, number>> {
  const object = envelope.spec.objects.find((entry) => entry.id === freedom.object);
  if (freedom.kind === 'freePoint' && object?.kind === 'freePoint') {
    return { x: object.x, y: object.y };
  }
  if (freedom.kind === 'line' && object?.kind === 'pointOnLine') {
    return evaluateInitialScalar(object.t, parameters);
  }
  if (freedom.kind === 'circle' && object?.kind === 'pointOnCircle') {
    return evaluateInitialScalar(object.angle, parameters);
  }
  if (freedom.kind === 'plane' && object?.kind === 'pointOnPlane') {
    return {
      u: evaluateInitialScalar(object.u, parameters),
      v: evaluateInitialScalar(object.v, parameters),
    };
  }
  if (freedom.kind === 'translate' && object?.kind === 'segment') {
    const endpoint = envelope.spec.objects.find(
      (entry) => entry.id === object.a && entry.kind === 'transformPoint',
    );
    const translation =
      endpoint?.kind === 'transformPoint'
        ? envelope.spec.objects.find(
            (entry) => entry.id === endpoint.transform && entry.kind === 'translate',
          )
        : undefined;
    if (translation?.kind === 'translate') {
      return Object.fromEntries(
        freedom.axes.map((axis) => [
          axis,
          evaluateInitialScalar(translation[`d${axis}` as 'dx' | 'dy' | 'dz'], parameters),
        ]),
      );
    }
  }
  throw new GeometryAuthoringError('invalid_snapshot', 'Geometry freedom initial is invalid.');
}

function initialInputsForEnvelope(
  envelope: GeometryEnvelopeV2,
): GeometryAuthoredSnapshotV1['inputs'] {
  const allParameters = new Map(
    envelope.spec.parameters.map((parameter) => [parameter.id, parameter.initial] as const),
  );
  return {
    parameters: Object.fromEntries(
      envelope.spec.interaction.parameters.map((id) => [id, allParameters.get(id)!]),
    ),
    freedoms: Object.fromEntries(
      envelope.spec.interaction.freedoms.map((freedom) => [
        freedom.id,
        freedomInitial(envelope, freedom, allParameters),
      ]),
    ),
  };
}

function defaultSnapshot(
  instanceId: string,
  envelope: GeometryEnvelopeV2,
): GeometryAuthoredSnapshotV1 {
  return {
    schemaVersion: GEOMETRY_AUTHORED_SNAPSHOT_SCHEMA_VERSION,
    instanceId,
    fingerprint: geometryEnvelopeFingerprint(envelope),
    inputs: initialInputsForEnvelope(envelope),
    camera: envelope.spec.presentation.camera,
  };
}

function refreshSnapshotInputs(
  snapshot: GeometryAuthoredSnapshotV1,
  envelope: GeometryEnvelopeV2,
): GeometryAuthoredSnapshotV1['inputs'] {
  const defaults = initialInputsForEnvelope(envelope);
  return {
    parameters: Object.fromEntries(
      Object.keys(defaults.parameters).map((id) => [
        id,
        snapshot.inputs.parameters[id] ?? defaults.parameters[id],
      ]),
    ),
    freedoms: Object.fromEntries(
      Object.keys(defaults.freedoms).map((id) => [
        id,
        snapshot.inputs.freedoms[id] ?? defaults.freedoms[id],
      ]),
    ),
  };
}

function assertProposalState(
  proposal: GeometryAuthoringEditProposal,
  marker: ParsedMarker,
  explorationPolicy?: GeometryExplorationPolicyV2,
): {
  inputs: GeometryAuthoredSnapshotV1['inputs'];
  auxiliary: GeometryAuxiliaryStateV2;
  camera: GeometryCamera;
} {
  const state = proposal.state;
  if (
    !Number.isInteger(proposal.wireSequence) ||
    proposal.wireSequence < 1 ||
    !plainRecord(state) ||
    !exactKeys(state, [
      'schemaVersion',
      'instanceId',
      'fingerprint',
      'inputs',
      'auxiliary',
      'hiddenAuxiliary',
      'selection',
      'visibleGroups',
      'camera',
    ]) ||
    state.schemaVersion !== 'reach-geometry-state/v2' ||
    state.instanceId !== marker.instanceId ||
    state.fingerprint !== marker.fingerprint ||
    !plainRecord(state.inputs) ||
    !exactKeys(state.inputs, ['parameters', 'freedoms'])
  ) {
    throw new GeometryAuthoringError('invalid_proposal', 'Geometry proposal state is invalid.');
  }
  const parameters = parseFiniteRecord(state.inputs.parameters);
  const freedoms = parseFreedomValues(state.inputs.freedoms);
  const camera = parseCamera(state.camera);
  const auxiliaryEnvelope =
    explorationPolicy === undefined
      ? marker.envelope
      : parseGeometryEnvelopeV2({
          ...marker.envelope,
          spec: {
            ...marker.envelope.spec,
            interaction: {
              ...marker.envelope.spec.interaction,
              exploration: explorationPolicy,
            },
          },
        });
  const auxiliary = validateGeometryAuxiliaryStateV2(auxiliaryEnvelope, state.auxiliary);
  if (parameters === undefined || freedoms === undefined || camera === undefined) {
    throw new GeometryAuthoringError('invalid_proposal', 'Geometry proposal values are invalid.');
  }
  return { inputs: { parameters, freedoms }, auxiliary, camera };
}

function assertEditable(marker: ParsedMarker): GeometryAuthoringBindingsV2 {
  const bindings = marker.envelope.spec.authoring;
  if (bindings === undefined) {
    throw new GeometryAuthoringError('read_only', 'Geometry marker has no authoring bindings.');
  }
  return bindings;
}

function parseAuthoredEnvelope(input: unknown): GeometryEnvelopeV2 {
  try {
    return parseGeometryEnvelopeV2(input).envelope;
  } catch (error) {
    if (error instanceof GeometryAuthoringError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new GeometryAuthoringError(
      'invalid_value',
      `The geometry change violates the authored envelope contract: ${reason}`,
    );
  }
}

/**
 * Adopt a trusted Player proposal as one authored document operation. Learner-prefixed temporary
 * nodes are promoted into stable base ids; the adjacent snapshot never stores auxiliary topology.
 */
export function applyGeometryEditProposal(input: {
  page: InteractivePage;
  proposal: GeometryAuthoringEditProposal;
}): InteractivePage {
  const { page, proposal } = input;
  if (proposal.pageId !== page.pageId || proposal.sourceRevision !== page.revision) {
    throw new GeometryAuthoringError('stale_revision', 'Geometry proposal targets a stale page.');
  }
  const parsed = parseMarkers(page.scene.documentHtml);
  const marker = markerFor(parsed.markers, proposal.instanceId);
  const bindings = assertEditable(marker);
  if (
    proposal.fingerprint !== marker.fingerprint ||
    geometryEnvelopeFingerprint(proposal.envelope) !== marker.fingerprint ||
    canonicalJson(proposal.envelope) !== canonicalJson(marker.envelope)
  ) {
    throw new GeometryAuthoringError(
      'stale_fingerprint',
      'Geometry proposal no longer matches the authored marker.',
    );
  }
  const state = assertProposalState(
    proposal,
    marker,
    geometryAuthoringExplorationPolicyV2(marker.envelope),
  );
  const mapping = allocateAuthoredIds(state.auxiliary, marker.envelope);
  const objects = state.auxiliary.objects.map((entry) => remapObject(entry, mapping));
  const measurements = state.auxiliary.measurements.map((entry) => remapDefinition(entry, mapping));
  const relations = state.auxiliary.relations.map((entry) => remapDefinition(entry, mapping));
  const freedoms = state.auxiliary.freedoms.map(
    (entry) =>
      ({
        ...entry,
        id: remapId(mapping, entry.id),
        object: remapId(mapping, entry.object),
      }) as GeometryFreedom,
  );
  const objectPresentation = state.auxiliary.presentation.objects.map((entry) => ({
    ...entry,
    object: remapId(mapping, entry.object),
  }));
  const measurementPresentation = state.auxiliary.presentation.measurements.map((entry) => ({
    ...entry,
    measurement: remapId(mapping, entry.measurement),
  }));
  const relationPresentation = state.auxiliary.presentation.relations.map((entry) => ({
    ...entry,
    relation: remapId(mapping, entry.relation),
  }));
  const newObjectIds = objects.map(({ id }) => id);
  const newMeasurementIds = measurements.map(({ id }) => id);
  const newRelationIds = relations.map(({ id }) => id);
  const newFreedomIds = freedoms.map(({ id }) => id);
  const envelope = parseAuthoredEnvelope({
    ...marker.envelope,
    spec: {
      ...marker.envelope.spec,
      objects: [...marker.envelope.spec.objects, ...objects],
      measurements: [...marker.envelope.spec.measurements, ...measurements],
      relations: [...marker.envelope.spec.relations, ...relations],
      presentation: {
        ...marker.envelope.spec.presentation,
        objects: [...marker.envelope.spec.presentation.objects, ...objectPresentation],
        measurements: [
          ...marker.envelope.spec.presentation.measurements,
          ...measurementPresentation,
        ],
        relations: [...marker.envelope.spec.presentation.relations, ...relationPresentation],
      },
      interaction: {
        ...marker.envelope.spec.interaction,
        freedoms: [...marker.envelope.spec.interaction.freedoms, ...freedoms],
        selectable: unique([...marker.envelope.spec.interaction.selectable, ...newObjectIds]),
      },
      authoring: {
        ...bindings,
        editable: {
          ...bindings.editable,
          objects: unique([...bindings.editable.objects, ...newObjectIds]),
          measurements: unique([...bindings.editable.measurements, ...newMeasurementIds]),
          relations: unique([...bindings.editable.relations, ...newRelationIds]),
          freedoms: unique([...bindings.editable.freedoms, ...newFreedomIds]),
        },
        deletable: {
          objects: unique([...bindings.deletable.objects, ...newObjectIds]),
          measurements: unique([...bindings.deletable.measurements, ...newMeasurementIds]),
          relations: unique([...bindings.deletable.relations, ...newRelationIds]),
        },
      },
    },
  });
  replaceEnvelope(marker, envelope);
  if (marker.snapshot !== undefined) {
    const snapshot: GeometryAuthoredSnapshotV1 = {
      ...marker.snapshot,
      fingerprint: geometryEnvelopeFingerprint(envelope),
      inputs: refreshSnapshotInputs(marker.snapshot, envelope),
    };
    writeSnapshot(parsed, marker, snapshot);
  }
  return {
    ...page,
    scene: { ...page.scene, documentHtml: serializeDocument(parsed.document) },
  };
}

function rewriteInstance(input: {
  page: InteractivePage;
  instanceId: string;
  expectedFingerprint: string;
  update: (
    envelope: GeometryEnvelopeV2,
    bindings: GeometryAuthoringBindingsV2,
  ) => GeometryEnvelopeV2;
  updateSnapshot?: (
    snapshot: GeometryAuthoredSnapshotV1,
    envelope: GeometryEnvelopeV2,
  ) => GeometryAuthoredSnapshotV1;
}): InteractivePage {
  const parsed = parseMarkers(input.page.scene.documentHtml);
  const marker = markerFor(parsed.markers, input.instanceId);
  const bindings = assertEditable(marker);
  if (marker.fingerprint !== input.expectedFingerprint) {
    throw new GeometryAuthoringError(
      'stale_fingerprint',
      'Geometry marker changed before editing.',
    );
  }
  const envelope = parseAuthoredEnvelope(input.update(marker.envelope, bindings));
  replaceEnvelope(marker, envelope);
  if (marker.snapshot !== undefined || input.updateSnapshot !== undefined) {
    const baseSnapshot = marker.snapshot ?? defaultSnapshot(marker.instanceId, marker.envelope);
    const snapshot = input.updateSnapshot?.(baseSnapshot, envelope) ?? {
      ...baseSnapshot,
      fingerprint: geometryEnvelopeFingerprint(envelope),
      inputs: refreshSnapshotInputs(baseSnapshot, envelope),
    };
    writeSnapshot(parsed, marker, snapshot);
  }
  return {
    ...input.page,
    scene: { ...input.page.scene, documentHtml: serializeDocument(parsed.document) },
  };
}

function referencedByBaseObject(object: GeometryObject, id: string): boolean {
  if (object.id === id) return false;
  const values = Object.entries(object)
    .filter(([key]) => !['id', 'kind'].includes(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
  return values.includes(id);
}

export function deleteGeometryAuthoredItem(input: {
  page: InteractivePage;
  instanceId: string;
  expectedFingerprint: string;
  category: 'objects' | 'measurements' | 'relations';
  id: string;
}): InteractivePage {
  return rewriteInstance({
    ...input,
    update: (envelope, bindings) => {
      if (bindings.externalReferences.includes(input.id)) {
        throw new GeometryAuthoringError(
          'external_reference',
          'An externally referenced geometry item cannot be deleted.',
        );
      }
      if (!bindings.deletable[input.category].includes(input.id)) {
        throw new GeometryAuthoringError('read_only', 'This geometry item is not deletable.');
      }
      if (
        input.category === 'objects' &&
        (envelope.spec.objects.some((object) => referencedByBaseObject(object, input.id)) ||
          envelope.spec.measurements.some((measurement) =>
            Object.values(measurement).includes(input.id),
          ) ||
          envelope.spec.relations.some((relation) => Object.values(relation).includes(input.id)))
      ) {
        throw new GeometryAuthoringError(
          'external_reference',
          'Delete dependent authored items before deleting this object.',
        );
      }
      const remove = <T extends { readonly id: string }>(entries: readonly T[]): T[] =>
        entries.filter((entry) => entry.id !== input.id);
      const nextBindings: GeometryAuthoringBindingsV2 = {
        ...bindings,
        editable: {
          ...bindings.editable,
          [input.category]: bindings.editable[input.category].filter((id) => id !== input.id),
        },
        deletable: {
          ...bindings.deletable,
          [input.category]: bindings.deletable[input.category].filter((id) => id !== input.id),
        },
      };
      if (input.category === 'objects') {
        const removedFreedomIds = envelope.spec.interaction.freedoms
          .filter((freedom) => freedom.object === input.id)
          .map(({ id }) => id);
        return {
          ...envelope,
          spec: {
            ...envelope.spec,
            objects: remove(envelope.spec.objects),
            presentation: {
              ...envelope.spec.presentation,
              objects: envelope.spec.presentation.objects.filter(
                (entry) => entry.object !== input.id,
              ),
            },
            interaction: {
              ...envelope.spec.interaction,
              freedoms: envelope.spec.interaction.freedoms.filter(
                (freedom) => freedom.object !== input.id,
              ),
              selectable: envelope.spec.interaction.selectable.filter((id) => id !== input.id),
              exploration: {
                ...envelope.spec.interaction.exploration,
                referenceableObjects:
                  envelope.spec.interaction.exploration.referenceableObjects.filter(
                    (id) => id !== input.id,
                  ),
              },
            },
            authoring: {
              ...nextBindings,
              editable: {
                ...nextBindings.editable,
                freedoms: nextBindings.editable.freedoms.filter(
                  (id) => !removedFreedomIds.includes(id),
                ),
              },
            },
          },
        };
      }
      if (input.category === 'measurements') {
        return {
          ...envelope,
          spec: {
            ...envelope.spec,
            measurements: remove(envelope.spec.measurements),
            presentation: {
              ...envelope.spec.presentation,
              measurements: envelope.spec.presentation.measurements.filter(
                (entry) => entry.measurement !== input.id,
              ),
              groups: envelope.spec.presentation.groups.map((group) => ({
                ...group,
                measurements: group.measurements.filter((id) => id !== input.id),
              })),
              rightAngles: envelope.spec.presentation.rightAngles.filter(
                (entry) => entry.measurement !== input.id,
              ),
            },
            authoring: nextBindings,
          },
        };
      }
      return {
        ...envelope,
        spec: {
          ...envelope.spec,
          relations: remove(envelope.spec.relations),
          presentation: {
            ...envelope.spec.presentation,
            relations: envelope.spec.presentation.relations.filter(
              (entry) => entry.relation !== input.id,
            ),
          },
          authoring: nextBindings,
        },
      };
    },
  });
}

export interface GeometryPresentationPatch {
  readonly label?: string;
  readonly colorToken?: GeometryPresentation['objects'][number]['colorToken'];
  readonly lineStyle?: GeometryPresentation['objects'][number]['lineStyle'];
  readonly visible?: boolean;
  readonly decimals?: number;
}

function normalizedPresentationPatch(patch: GeometryPresentationPatch): GeometryPresentationPatch {
  if (patch.label === undefined || patch.label.trim().length > 0) return patch;
  const { label: _label, ...withoutLabel } = patch;
  return withoutLabel;
}

function mergePresentation<T extends object>(
  current: T,
  patch: GeometryPresentationPatch,
): T & GeometryPresentationPatch {
  const merged = { ...current, ...normalizedPresentationPatch(patch) } as T &
    GeometryPresentationPatch;
  if (patch.label !== undefined && patch.label.trim().length === 0) {
    delete (merged as { label?: string }).label;
  }
  return merged;
}

export function updateGeometryAuthoredPresentation(input: {
  page: InteractivePage;
  instanceId: string;
  expectedFingerprint: string;
  category: 'objects' | 'measurements' | 'relations';
  id: string;
  patch: GeometryPresentationPatch;
}): InteractivePage {
  return rewriteInstance({
    ...input,
    update: (envelope, bindings) => {
      if (!bindings.editable[input.category].includes(input.id)) {
        throw new GeometryAuthoringError('read_only', 'This geometry item is not editable.');
      }
      const presentation = envelope.spec.presentation;
      const normalizedPatch = normalizedPresentationPatch(input.patch);
      if (input.category === 'objects') {
        const current = presentation.objects.find((entry) => entry.object === input.id) ?? {
          object: input.id,
        };
        return {
          ...envelope,
          spec: {
            ...envelope.spec,
            presentation: {
              ...presentation,
              objects: [
                ...presentation.objects.filter((entry) => entry.object !== input.id),
                { ...mergePresentation(current, input.patch), object: input.id },
              ],
            },
          },
        };
      }
      if (input.category === 'measurements') {
        const current = presentation.measurements.find(
          (entry) => entry.measurement === input.id,
        ) ?? { measurement: input.id };
        const { colorToken: _color, lineStyle: _line, ...patch } = normalizedPatch;
        return {
          ...envelope,
          spec: {
            ...envelope.spec,
            presentation: {
              ...presentation,
              measurements: [
                ...presentation.measurements.filter((entry) => entry.measurement !== input.id),
                { ...mergePresentation(current, patch), measurement: input.id },
              ],
            },
          },
        };
      }
      const current = presentation.relations.find((entry) => entry.relation === input.id) ?? {
        relation: input.id,
      };
      const {
        colorToken: _color,
        lineStyle: _line,
        decimals: _decimals,
        ...patch
      } = normalizedPatch;
      return {
        ...envelope,
        spec: {
          ...envelope.spec,
          presentation: {
            ...presentation,
            relations: [
              ...presentation.relations.filter((entry) => entry.relation !== input.id),
              {
                ...mergePresentation(current, patch),
                relation: input.id,
              } as GeometryRelationPresentationV2,
            ],
          },
        },
      };
    },
  });
}

export function updateGeometryExplorationPolicy(input: {
  page: InteractivePage;
  instanceId: string;
  expectedFingerprint: string;
  policy: GeometryExplorationPolicyV2;
}): InteractivePage {
  return rewriteInstance({
    ...input,
    update: (envelope) => ({
      ...envelope,
      spec: {
        ...envelope.spec,
        interaction: {
          ...envelope.spec.interaction,
          exploration: input.policy,
        },
      },
    }),
  });
}

export interface GeometryParameterAuthoringSetting {
  readonly id: string;
  readonly learnerEditable: boolean;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

function scalarParameter(value: unknown): string | undefined {
  return plainRecord(value) &&
    exactKeys(value, ['parameter']) &&
    typeof value.parameter === 'string'
    ? value.parameter
    : undefined;
}

function freedomAliasesParameter(
  objects: readonly GeometryObject[],
  freedom: GeometryFreedom,
  parameterId: string,
): boolean {
  const target = objects.find((object) => object.id === freedom.object);
  if (target === undefined) return false;
  if (freedom.kind === 'freePoint' && target.kind === 'freePoint') {
    return scalarParameter(target.x) === parameterId || scalarParameter(target.y) === parameterId;
  }
  if (freedom.kind === 'line' && target.kind === 'pointOnLine') {
    return scalarParameter(target.t) === parameterId;
  }
  if (freedom.kind === 'circle' && target.kind === 'pointOnCircle') {
    return scalarParameter(target.angle) === parameterId;
  }
  if (freedom.kind === 'plane' && target.kind === 'pointOnPlane') {
    return scalarParameter(target.u) === parameterId || scalarParameter(target.v) === parameterId;
  }
  if (freedom.kind !== 'translate' || target.kind !== 'segment') return false;
  const endpoint = objects.find(
    (object) => object.id === target.a && object.kind === 'transformPoint',
  );
  const translation =
    endpoint?.kind === 'transformPoint'
      ? objects.find((object) => object.id === endpoint.transform && object.kind === 'translate')
      : undefined;
  return (
    translation?.kind === 'translate' &&
    [translation.dx, translation.dy, translation.dz].some(
      (scalar) => scalarParameter(scalar) === parameterId,
    )
  );
}

/** Updates parameter permissions/ranges and any exact freedom range that aliases that parameter. */
export function updateGeometryParameterAuthoring(input: {
  page: InteractivePage;
  instanceId: string;
  expectedFingerprint: string;
  settings: readonly GeometryParameterAuthoringSetting[];
}): InteractivePage {
  return rewriteInstance({
    ...input,
    update: (envelope, bindings) => {
      const settingById = new Map(input.settings.map((setting) => [setting.id, setting]));
      const authoringEditable = new Set(bindings.editable.parameters);
      if (
        settingById.size !== input.settings.length ||
        settingById.size !== envelope.spec.parameters.length ||
        input.settings.some(
          (setting) =>
            !envelope.spec.parameters.some((parameter) => parameter.id === setting.id) ||
            !Number.isFinite(setting.min) ||
            !Number.isFinite(setting.max) ||
            !Number.isFinite(setting.step) ||
            setting.max <= setting.min ||
            setting.step <= 0,
        )
      ) {
        throw new GeometryAuthoringError(
          'unsupported_initial_value',
          'Geometry parameter settings are invalid.',
        );
      }
      for (const parameter of envelope.spec.parameters) {
        const setting = settingById.get(parameter.id)!;
        if (
          !authoringEditable.has(parameter.id) &&
          (setting.learnerEditable !==
            envelope.spec.interaction.parameters.includes(parameter.id) ||
            setting.min !== parameter.min ||
            setting.max !== parameter.max ||
            setting.step !== parameter.step)
        ) {
          throw new GeometryAuthoringError(
            'read_only',
            'An unbound parameter cannot be changed directly.',
          );
        }
      }
      const parameters = envelope.spec.parameters.map((parameter) => {
        const setting = settingById.get(parameter.id);
        if (setting === undefined || !authoringEditable.has(parameter.id)) return parameter;
        if (parameter.initial < setting.min || parameter.initial > setting.max) {
          throw new GeometryAuthoringError(
            'unsupported_initial_value',
            'Parameter range must contain its current initial value.',
          );
        }
        return { ...parameter, min: setting.min, max: setting.max, step: setting.step };
      });
      const changedRangeIds = new Set(
        envelope.spec.parameters
          .filter((parameter) => {
            const setting = settingById.get(parameter.id)!;
            return (
              setting.min !== parameter.min ||
              setting.max !== parameter.max ||
              setting.step !== parameter.step
            );
          })
          .map(({ id }) => id),
      );
      const freedoms = envelope.spec.interaction.freedoms.map((freedom) => {
        const aliased = input.settings.filter(
          (setting) =>
            changedRangeIds.has(setting.id) &&
            freedomAliasesParameter(envelope.spec.objects, freedom, setting.id),
        );
        if (aliased.length === 0) return freedom;
        if (freedom.kind === 'line' || freedom.kind === 'circle') {
          const setting = aliased[0]!;
          return {
            ...freedom,
            range: { min: setting.min, max: setting.max, step: setting.step },
          };
        }
        if (freedom.kind === 'plane') {
          const target = envelope.spec.objects.find((object) => object.id === freedom.object);
          return {
            ...freedom,
            ...(target?.kind === 'pointOnPlane' && scalarParameter(target.u)
              ? {
                  u: (() => {
                    const setting = settingById.get(scalarParameter(target.u)!);
                    return setting === undefined
                      ? freedom.u
                      : { min: setting.min, max: setting.max, step: setting.step };
                  })(),
                }
              : {}),
            ...(target?.kind === 'pointOnPlane' && scalarParameter(target.v)
              ? {
                  v: (() => {
                    const setting = settingById.get(scalarParameter(target.v)!);
                    return setting === undefined
                      ? freedom.v
                      : { min: setting.min, max: setting.max, step: setting.step };
                  })(),
                }
              : {}),
          };
        }
        if (freedom.kind === 'translate') {
          const target = envelope.spec.objects.find((object) => object.id === freedom.object);
          const endpoint =
            target?.kind === 'segment'
              ? envelope.spec.objects.find(
                  (object) => object.id === target.a && object.kind === 'transformPoint',
                )
              : undefined;
          const translation =
            endpoint?.kind === 'transformPoint'
              ? envelope.spec.objects.find(
                  (object) => object.id === endpoint.transform && object.kind === 'translate',
                )
              : undefined;
          if (translation?.kind !== 'translate') return freedom;
          return {
            ...freedom,
            ranges: freedom.ranges.map((range) => {
              const parameterId = scalarParameter(
                translation[`d${range.axis}` as 'dx' | 'dy' | 'dz'],
              );
              const setting = parameterId === undefined ? undefined : settingById.get(parameterId);
              if (
                parameterId === undefined ||
                setting === undefined ||
                !changedRangeIds.has(parameterId)
              ) {
                return range;
              }
              return { ...range, min: setting.min, max: setting.max, step: setting.step };
            }),
          };
        }
        if (freedom.kind === 'freePoint') {
          throw new GeometryAuthoringError(
            'unsupported_initial_value',
            'Free-point scalar aliases are not supported by this contract.',
          );
        }
        return freedom;
      });
      return {
        ...envelope,
        spec: {
          ...envelope.spec,
          parameters,
          interaction: {
            ...envelope.spec.interaction,
            parameters: input.settings
              .filter((setting) => setting.learnerEditable)
              .map((setting) => setting.id),
            freedoms,
          },
        },
      };
    },
  });
}

function valueInRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

interface GeometryInitialGraph {
  readonly objects: readonly GeometryObject[];
  readonly parameters: readonly GeometryEnvelopeV2['spec']['parameters'][number][];
}

function applyScalarInitial(
  graph: GeometryInitialGraph,
  objectId: string,
  field: 'x' | 'y' | 't' | 'angle' | 'u' | 'v' | 'dx' | 'dy' | 'dz',
  value: number,
  editableParameters: ReadonlySet<string>,
): GeometryInitialGraph {
  const objectIndex = graph.objects.findIndex((object) => object.id === objectId);
  if (objectIndex < 0) {
    throw new GeometryAuthoringError('unsupported_initial_value', 'Freedom object is missing.');
  }
  const object = graph.objects[objectIndex]! as GeometryObject & Record<string, unknown>;
  const current = object[field];
  if (
    plainRecord(current) &&
    exactKeys(current, ['parameter']) &&
    typeof current.parameter === 'string'
  ) {
    if (!editableParameters.has(current.parameter)) {
      throw new GeometryAuthoringError(
        'unsupported_initial_value',
        'A freedom cannot override an unbound parameter alias.',
      );
    }
    const parameterIndex = graph.parameters.findIndex(
      (parameter) => parameter.id === current.parameter,
    );
    const parameter = graph.parameters[parameterIndex];
    if (parameter === undefined || !valueInRange(value, parameter)) {
      throw new GeometryAuthoringError(
        'unsupported_initial_value',
        'Aliased parameter value is outside its range.',
      );
    }
    const parameters = [...graph.parameters];
    parameters[parameterIndex] = { ...parameter, initial: value };
    return { ...graph, parameters };
  }
  if (typeof current !== 'number') {
    throw new GeometryAuthoringError(
      'unsupported_initial_value',
      'A compound scalar cannot be replaced by a freedom value.',
    );
  }
  const objects = [...graph.objects];
  objects[objectIndex] = { ...object, [field]: value } as unknown as GeometryObject;
  return { ...graph, objects };
}

function applyFreedomInitial(
  graph: GeometryInitialGraph,
  freedom: GeometryFreedom,
  value: number | Readonly<Record<string, number>>,
  editableParameters: ReadonlySet<string>,
): GeometryInitialGraph {
  const index = graph.objects.findIndex((object) => object.id === freedom.object);
  if (index < 0) {
    throw new GeometryAuthoringError('unsupported_initial_value', 'Freedom object is missing.');
  }
  const object = graph.objects[index]!;
  if (freedom.kind === 'freePoint' && object.kind === 'freePoint' && plainRecord(value)) {
    const x = value.x;
    const y = value.y;
    if (
      typeof x === 'number' &&
      typeof y === 'number' &&
      valueInRange(x, freedom.x) &&
      valueInRange(y, freedom.y)
    ) {
      return applyScalarInitial(
        applyScalarInitial(graph, object.id, 'x', x, editableParameters),
        object.id,
        'y',
        y,
        editableParameters,
      );
    }
  } else if (
    (freedom.kind === 'line' || freedom.kind === 'circle') &&
    typeof value === 'number' &&
    valueInRange(value, freedom.range)
  ) {
    if (freedom.kind === 'line' && object.kind === 'pointOnLine') {
      return applyScalarInitial(graph, object.id, 't', value, editableParameters);
    }
    if (freedom.kind === 'circle' && object.kind === 'pointOnCircle') {
      return applyScalarInitial(graph, object.id, 'angle', value, editableParameters);
    }
  } else if (
    freedom.kind === 'plane' &&
    object.kind === 'pointOnPlane' &&
    plainRecord(value) &&
    typeof value.u === 'number' &&
    typeof value.v === 'number' &&
    valueInRange(value.u, freedom.u) &&
    valueInRange(value.v, freedom.v)
  ) {
    return applyScalarInitial(
      applyScalarInitial(graph, object.id, 'u', value.u, editableParameters),
      object.id,
      'v',
      value.v,
      editableParameters,
    );
  } else if (freedom.kind === 'translate' && object.kind === 'segment' && plainRecord(value)) {
    const endpoint = graph.objects.find(
      (candidate) => candidate.id === object.a && candidate.kind === 'transformPoint',
    );
    const translation =
      endpoint?.kind === 'transformPoint'
        ? graph.objects.find(
            (candidate) => candidate.id === endpoint.transform && candidate.kind === 'translate',
          )
        : undefined;
    if (translation?.kind !== 'translate') {
      throw new GeometryAuthoringError(
        'unsupported_initial_value',
        'Translation freedom has no authored translation object.',
      );
    }
    let nextGraph = graph;
    for (const range of freedom.ranges) {
      const axisValue = value[range.axis];
      if (typeof axisValue !== 'number' || !valueInRange(axisValue, range)) {
        throw new GeometryAuthoringError(
          'unsupported_initial_value',
          'Translation freedom value is outside its range.',
        );
      }
      nextGraph = applyScalarInitial(
        nextGraph,
        translation.id,
        `d${range.axis}` as 'dx' | 'dy' | 'dz',
        axisValue,
        editableParameters,
      );
    }
    return nextGraph;
  }
  throw new GeometryAuthoringError(
    'unsupported_initial_value',
    'Freedom value cannot be written to this construction.',
  );
}

/** Writes only explicitly bound inputs plus camera; auxiliary topology never enters this snapshot. */
export function setGeometryAuthoredInitialState(input: {
  page: InteractivePage;
  instanceId: string;
  expectedFingerprint: string;
  state: GeometryAuthoringEditProposal['state'];
}): InteractivePage {
  return rewriteInstance({
    ...input,
    update: (envelope, bindings) => {
      const marker = {
        instanceId: input.instanceId,
        envelope,
        fingerprint: input.expectedFingerprint,
      } as ParsedMarker;
      const state = assertProposalState(
        {
          schemaVersion: 'reach-geometry-edit-proposal/v1',
          pageId: input.page.pageId,
          sourceRevision: input.page.revision,
          instanceId: input.instanceId,
          fingerprint: input.expectedFingerprint,
          envelope,
          state: input.state,
          wireSequence: 1,
        },
        marker,
      );
      const parameters = envelope.spec.parameters.map((parameter) => {
        if (!bindings.editable.parameters.includes(parameter.id)) return parameter;
        const value = state.inputs.parameters[parameter.id];
        if (value === undefined && !envelope.spec.interaction.parameters.includes(parameter.id)) {
          return parameter;
        }
        if (value === undefined || !valueInRange(value, parameter)) {
          throw new GeometryAuthoringError(
            'unsupported_initial_value',
            'Parameter initial value is outside its range.',
          );
        }
        return { ...parameter, initial: value };
      });
      let graph: GeometryInitialGraph = { objects: envelope.spec.objects, parameters };
      const editableParameters = new Set(bindings.editable.parameters);
      for (const freedom of envelope.spec.interaction.freedoms) {
        if (!bindings.editable.freedoms.includes(freedom.id)) continue;
        const value = state.inputs.freedoms[freedom.id];
        if (value === undefined) {
          throw new GeometryAuthoringError(
            'unsupported_initial_value',
            'Editable freedom is missing from the proposal.',
          );
        }
        graph = applyFreedomInitial(graph, freedom, value, editableParameters);
      }
      return {
        ...envelope,
        spec: {
          ...envelope.spec,
          parameters: graph.parameters,
          objects: graph.objects,
          presentation: { ...envelope.spec.presentation, camera: state.camera },
        },
      };
    },
    updateSnapshot: (_snapshot, envelope) => {
      const state = input.state as Record<string, unknown>;
      return {
        schemaVersion: GEOMETRY_AUTHORED_SNAPSHOT_SCHEMA_VERSION,
        instanceId: input.instanceId,
        fingerprint: geometryEnvelopeFingerprint(envelope),
        inputs: initialInputsForEnvelope(envelope),
        camera: parseCamera(state.camera)!,
      };
    },
  });
}

export function geometryAuthoringItem(input: {
  envelope: GeometryEnvelopeV2;
  category: 'objects' | 'measurements' | 'relations';
  id: string;
}):
  | GeometryObject
  | GeometryMeasurement
  | GeometryEnvelopeV2['spec']['relations'][number]
  | undefined {
  return input.envelope.spec[input.category].find((entry) => entry.id === input.id);
}
