import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  parseGeometryEnvelope,
  validateGeometryCamera,
  type GeometryCamera,
  type GeometryPresentation,
  type GeometryRange,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  createGeometryEngine,
  GeometryInputError,
  type GeometryEngine,
  type GeometryInputState,
  type GeometrySnapshot,
} from './index.js';

export type GeometryFreedomValue = number | Readonly<Record<string, number>>;
export type GeometrySessionCommand =
  | { readonly kind: 'setParameter'; readonly id: string; readonly value: number }
  | { readonly kind: 'setFreedom'; readonly id: string; readonly value: GeometryFreedomValue }
  | { readonly kind: 'select'; readonly objectId: string | null }
  | { readonly kind: 'setGroup'; readonly id: string; readonly visible: boolean }
  | { readonly kind: 'setCamera'; readonly camera: GeometryCamera }
  | { readonly kind: 'reset' };
export type GeometryCommand =
  | (GeometrySessionCommand & { readonly schemaVersion: 'reach-geometry-command/v1' })
  | {
      readonly schemaVersion: 'reach-geometry-command/v1';
      readonly commands: readonly GeometrySessionCommand[];
    };
export interface GeometrySessionState {
  readonly schemaVersion: 'reach-geometry-state/v1';
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly inputs: GeometryInputState;
  readonly selection: string | null;
  readonly visibleGroups: readonly string[];
  readonly camera: GeometryCamera;
}
export interface GeometryComputedState extends GeometrySnapshot {
  readonly schemaVersion: 'reach-geometry-computed/v1';
  readonly instanceId: string;
  readonly geometryRevision: number;
  readonly selection: string | null;
  readonly visibleGroups: readonly string[];
  readonly camera: GeometryCamera;
}
export interface GeometrySessionChange {
  readonly kind: GeometrySessionCommand['kind'] | 'batch';
  readonly inputKeys: readonly string[];
  readonly viewKeys: readonly string[];
}
export type GeometrySessionResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly revision: number;
      readonly change?: GeometrySessionChange;
    }
  | { readonly ok: false; readonly code: string };
export interface GeometrySession {
  getState(): GeometrySessionState;
  getComputedState(): GeometryComputedState;
  setState(state: unknown): GeometrySessionResult;
  applyCommand(command: unknown): GeometrySessionResult;
  reset(): GeometrySessionResult;
  dispose(): void;
}

class SessionError extends Error {}
function fail(code = 'invalid_input'): never {
  throw new SessionError(code);
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail();
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Accept JSON data only: getters, prototypes, sparse arrays and cycles cannot cross the API.
function copyJson(value: unknown): unknown {
  let remaining = 8192;
  const copy = (input: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 16) fail();
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (input.length > 65536) fail();
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail();
      return input === 0 ? 0 : input;
    }
    if (!input || typeof input !== 'object') return fail();
    const array = Array.isArray(input);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 8192 || keys.some((key) => typeof key !== 'string')) fail();
    if (array && (keys.length !== input.length + 1 || input.length > 8192)) fail();
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      output[key as string] = copy(descriptor.value, depth + 1);
    }
    if (array) {
      if (Object.keys(output).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || +key >= input.length))
        fail();
      return Array.from({ length: input.length }, (_, index) => output[index]);
    }
    return output;
  };
  return copy(value, 0);
}
function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${normalized((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown): boolean => normalized(a) === normalized(b);

export function isGeometryItemVisible(
  presentation: GeometryPresentation,
  visibleGroups: readonly string[],
  kind: 'object' | 'measurement',
  id: string,
): boolean {
  const item =
    kind === 'object'
      ? presentation.objects.find((entry) => entry.object === id)
      : presentation.measurements.find((entry) => entry.measurement === id);
  if (item?.visible === false) return false;
  const groups = presentation.groups.filter((group) =>
    (kind === 'object' ? group.objects : group.measurements).includes(id),
  );
  return groups.length === 0 || groups.some((group) => visibleGroups.includes(group.id));
}

export function createGeometrySession(
  input: unknown,
  instanceId: string,
  options: { readonly engine?: GeometryEngine } = {},
): GeometrySession {
  const { envelope } = parseGeometryEnvelope(input);
  if (typeof instanceId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(instanceId))
    fail('invalid_instance');
  const spec = envelope.spec;
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(normalized(envelope))));
  const engine = options.engine ?? createGeometryEngine(envelope);
  let snapshot = engine.snapshot();
  const editable = (inputs: GeometryInputState): GeometryInputState => ({
    parameters: Object.fromEntries(
      spec.interaction.parameters.map((id) => [id, inputs.parameters[id]]),
    ),
    freedoms: inputs.freedoms,
  });
  const initial = freeze({
    schemaVersion: 'reach-geometry-state/v1' as const,
    instanceId,
    fingerprint,
    inputs: editable(snapshot.inputs),
    selection: null,
    visibleGroups: spec.presentation.groups
      .filter((group) => spec.interaction.visibleGroups.includes(group.id))
      .map((group) => group.id),
    camera: spec.presentation.camera,
  });
  let state: GeometrySessionState = initial;
  let revision = 0,
    geometryRevision = 0,
    disposed = false;
  const groupIds = spec.presentation.groups.map((group) => group.id);
  const parameterRanges = new Map(spec.parameters.map((parameter) => [parameter.id, parameter]));
  const freedomRanges = new Map(
    spec.interaction.freedoms.map(
      (freedom): [string, GeometryRange | Record<string, GeometryRange>] => [
        freedom.id,
        freedom.kind === 'line' || freedom.kind === 'circle'
          ? freedom.range
          : freedom.kind === 'freePoint'
            ? { x: freedom.x, y: freedom.y }
            : freedom.kind === 'plane'
              ? { u: freedom.u, v: freedom.v }
              : freedom.kind === 'translate'
                ? Object.fromEntries(freedom.ranges.map((range) => [range.axis, range]))
                : fail(),
      ],
    ),
  );
  const inRange = (value: unknown, range: GeometryRange): void => {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < range.min ||
      value > range.max
    )
      fail();
  };
  const validateInputs = (inputs: unknown, complete: boolean): GeometryInputState => {
    record(inputs);
    exact(inputs, ['parameters', 'freedoms']);
    record(inputs.parameters);
    record(inputs.freedoms);
    if (complete) {
      exact(inputs.parameters, spec.interaction.parameters);
      exact(inputs.freedoms, [...freedomRanges.keys()]);
    }
    for (const [id, value] of Object.entries(inputs.parameters)) {
      if (!spec.interaction.parameters.includes(id)) fail('unknown_input');
      inRange(value, parameterRanges.get(id)!);
    }
    for (const [id, value] of Object.entries(inputs.freedoms)) {
      const ranges = freedomRanges.get(id);
      if (!ranges) fail('unknown_input');
      if (typeof ranges.min === 'number') inRange(value, ranges as GeometryRange);
      else {
        record(value);
        exact(value, Object.keys(ranges));
        for (const [field, range] of Object.entries(ranges))
          inRange(value[field], range as GeometryRange);
      }
    }
    return inputs as unknown as GeometryInputState;
  };
  const validateView = (value: Record<string, unknown>): void => {
    if (
      value.selection !== null &&
      (typeof value.selection !== 'string' ||
        !spec.interaction.selectable.includes(value.selection))
    )
      fail('unknown_selection');
    if (
      !Array.isArray(value.visibleGroups) ||
      value.visibleGroups.length > groupIds.length ||
      new Set(value.visibleGroups).size !== value.visibleGroups.length ||
      value.visibleGroups.some((id) => typeof id !== 'string' || !groupIds.includes(id))
    )
      fail('unknown_group');
    validateGeometryCamera(value.camera, spec.dimension);
  };
  const safely = (operation: () => GeometrySessionResult): GeometrySessionResult => {
    if (disposed) return freeze({ ok: false, code: 'disposed' });
    try {
      return freeze(operation());
    } catch (error) {
      return freeze({
        ok: false,
        code:
          error instanceof SessionError
            ? error.message
            : error instanceof GeometryInputError
              ? error.code
              : 'invalid_input',
      });
    }
  };
  const adopt = (
    next: GeometrySessionState,
    patch: GeometryInputState,
    kind?: GeometrySessionChange['kind'],
  ): GeometrySessionResult => {
    validateInputs(patch, false);
    validateView(next as unknown as Record<string, unknown>);
    const needsGeometry =
      Object.entries(patch.parameters).some(
        ([id, value]) => value !== state.inputs.parameters[id],
      ) ||
      Object.entries(patch.freedoms).some(([id, value]) => !same(value, state.inputs.freedoms[id]));
    if (needsGeometry) snapshot = engine.applyInputs(patch);
    const actual = {
      ...next,
      inputs: editable(snapshot.inputs),
      visibleGroups: groupIds.filter((id) => next.visibleGroups.includes(id)),
    };
    const inputKeys = [
      ...spec.interaction.parameters
        .filter((id) => actual.inputs.parameters[id] !== state.inputs.parameters[id])
        .map((id) => `parameter:${id}`),
      ...[...freedomRanges.keys()]
        .filter((id) => !same(actual.inputs.freedoms[id], state.inputs.freedoms[id]))
        .map((id) => `freedom:${id}`),
    ];
    const viewKeys = (['selection', 'visibleGroups', 'camera'] as const).filter(
      (key) => !same(actual[key], state[key]),
    );
    const changed = inputKeys.length > 0 || viewKeys.length > 0;
    if (changed) {
      state = freeze(actual);
      revision++;
      if (inputKeys.length) geometryRevision++;
    }
    return {
      ok: true,
      changed,
      revision,
      ...(changed && kind ? { change: { kind, inputKeys, viewKeys } } : {}),
    };
  };
  const reset = (): GeometrySessionResult => safely(() => adopt(initial, initial.inputs, 'reset'));
  return Object.freeze({
    getState: () => state,
    getComputedState: () =>
      freeze({
        ...snapshot,
        schemaVersion: 'reach-geometry-computed/v1' as const,
        instanceId,
        revision,
        geometryRevision,
        selection: state.selection,
        visibleGroups: state.visibleGroups,
        camera: state.camera,
      }),
    setState: (input: unknown) =>
      safely(() => {
        const value = copyJson(input);
        record(value);
        exact(value, [
          'schemaVersion',
          'instanceId',
          'fingerprint',
          'inputs',
          'selection',
          'visibleGroups',
          'camera',
        ]);
        if (value.schemaVersion !== initial.schemaVersion) fail('schema_mismatch');
        if (value.instanceId !== instanceId) fail('instance_mismatch');
        if (value.fingerprint !== fingerprint) fail('fingerprint_mismatch');
        const inputs = validateInputs(value.inputs, true);
        return adopt(value as unknown as GeometrySessionState, inputs);
      }),
    applyCommand: (input: unknown) =>
      safely(() => {
        const value = copyJson(input);
        record(value);
        if (value.schemaVersion !== 'reach-geometry-command/v1') fail('schema_mismatch');
        const batch = Object.hasOwn(value, 'commands');
        if (batch) exact(value, ['schemaVersion', 'commands']);
        const { schemaVersion: _, ...single } = value;
        const commands = batch ? value.commands : [single];
        if (!Array.isArray(commands) || commands.length < 1 || commands.length > 32)
          fail('invalid_command');
        const parameters: Record<string, number> = Object.create(null);
        const freedoms: Record<string, GeometryFreedomValue> = Object.create(null);
        let next = { ...state };
        const writes = new Map<string, unknown>();
        const write = (key: string, value: unknown): void => {
          if (writes.has(key) && !same(writes.get(key), value)) fail('input_conflict');
          writes.set(key, value);
        };
        for (const command of commands) {
          record(command);
          if (command.kind === 'reset') {
            exact(command, ['kind']);
            if (commands.length !== 1) fail('invalid_command');
            return adopt(initial, initial.inputs, 'reset');
          }
          if (command.kind === 'setParameter' || command.kind === 'setFreedom') {
            exact(command, ['kind', 'id', 'value']);
            if (typeof command.id !== 'string') fail();
            write(`${command.kind}:${command.id}`, command.value);
            if (command.kind === 'setParameter') parameters[command.id] = command.value as number;
            else freedoms[command.id] = command.value as GeometryFreedomValue;
          } else if (command.kind === 'select') {
            exact(command, ['kind', 'objectId']);
            write('selection', command.objectId);
            next = { ...next, selection: command.objectId as string | null };
          } else if (command.kind === 'setGroup') {
            exact(command, ['kind', 'id', 'visible']);
            if (
              typeof command.id !== 'string' ||
              !groupIds.includes(command.id) ||
              typeof command.visible !== 'boolean'
            )
              fail('unknown_group');
            write(`group:${command.id}`, command.visible);
            next = {
              ...next,
              visibleGroups: command.visible
                ? [...new Set([...next.visibleGroups, command.id])]
                : next.visibleGroups.filter((id) => id !== command.id),
            };
          } else if (command.kind === 'setCamera') {
            exact(command, ['kind', 'camera']);
            write('camera', command.camera);
            next = { ...next, camera: command.camera as GeometryCamera };
          } else fail('invalid_command');
        }
        return adopt(
          next,
          { parameters, freedoms },
          batch ? 'batch' : (single.kind as GeometrySessionChange['kind']),
        );
      }),
    reset,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        engine.dispose();
      }
    },
  });
}
