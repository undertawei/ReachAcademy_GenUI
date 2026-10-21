import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  GeometryContractError,
  validateGeometryCamera,
  type GeometryCamera,
  type GeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  composeGeometryEnvelopeV2,
  parseGeometryEnvelopeV2,
  type ComposedGeometryEnvelopeV2,
  type GeometryAuxiliaryStateV2,
  type GeometryEnvelopeV2,
  type GeometryExplorationPolicyV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import {
  createGeometryEngine,
  GeometryInputError,
  type GeometryEngine,
  type GeometryInputState,
  type GeometrySnapshot,
} from './index.js';
import {
  geometryAuxiliaryDeleteImpact,
  removeGeometryAuxiliaryImpact,
  type GeometryDeleteImpactV2,
} from './exploration.js';
import { evaluateGeometryRelations, type GeometryRelationState } from './relations.js';

export type GeometryFreedomValueV2 = number | Readonly<Record<string, number>>;
export type GeometrySessionCommandV2 =
  | { readonly kind: 'setParameter'; readonly id: string; readonly value: number }
  | { readonly kind: 'setFreedom'; readonly id: string; readonly value: GeometryFreedomValueV2 }
  | { readonly kind: 'select'; readonly objectId: string | null }
  | { readonly kind: 'setGroup'; readonly id: string; readonly visible: boolean }
  | { readonly kind: 'setCamera'; readonly camera: GeometryCamera }
  | { readonly kind: 'addAuxiliary'; readonly auxiliary: GeometryAuxiliaryStateV2 }
  | { readonly kind: 'deleteAuxiliary'; readonly id: string }
  | { readonly kind: 'setAuxiliaryHidden'; readonly id: string; readonly hidden: boolean }
  | { readonly kind: 'clearAuxiliary' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' };
export type GeometryCommandV2 =
  | (GeometrySessionCommandV2 & {
      readonly schemaVersion: 'reach-geometry-command/v2';
      readonly historyGroup?: string;
    })
  | {
      readonly schemaVersion: 'reach-geometry-command/v2';
      readonly commands: readonly GeometrySessionCommandV2[];
      readonly historyGroup?: string;
    };

export interface GeometrySessionStateV2 {
  readonly schemaVersion: 'reach-geometry-state/v2';
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly inputs: GeometryInputState;
  readonly auxiliary: GeometryAuxiliaryStateV2;
  readonly hiddenAuxiliary: readonly string[];
  readonly selection: string | null;
  readonly visibleGroups: readonly string[];
  readonly camera: GeometryCamera;
}

export interface GeometryComputedStateV2 extends Omit<GeometrySnapshot, 'revision'> {
  readonly schemaVersion: 'reach-geometry-computed/v2';
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly revision: number;
  readonly geometryRevision: number;
  readonly modelRevision: number;
  readonly auxiliary: GeometryAuxiliaryStateV2;
  readonly hiddenAuxiliary: readonly string[];
  readonly selection: string | null;
  readonly visibleGroups: readonly string[];
  readonly camera: GeometryCamera;
  readonly relations: Readonly<Record<string, GeometryRelationState>>;
}

export interface GeometrySessionChangeV2 {
  readonly kind: GeometrySessionCommandV2['kind'] | 'batch';
  readonly inputKeys: readonly string[];
  readonly viewKeys: readonly string[];
  readonly structureKeys: readonly string[];
}

export type GeometrySessionResultV2 =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly revision: number;
      readonly change?: GeometrySessionChangeV2;
    }
  | { readonly ok: false; readonly code: string };

export type GeometryDeleteImpactResultV2 =
  | { readonly ok: true; readonly impact: GeometryDeleteImpactV2 }
  | { readonly ok: false; readonly code: string };

export interface GeometrySessionV2 {
  getState(): GeometrySessionStateV2;
  getComputedState(): GeometryComputedStateV2;
  getDeleteImpact(id: string): GeometryDeleteImpactResultV2;
  setState(state: unknown): GeometrySessionResultV2;
  applyCommand(command: unknown): GeometrySessionResultV2;
  reset(): GeometrySessionResultV2;
  dispose(): void;
}

export type GeometryEngineFactoryV2 = (envelope: GeometryEnvelope) => GeometryEngine;

export interface GeometrySessionInitialV2 {
  readonly schemaVersion: 'reach-geometry-authored-snapshot/v1';
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly inputs: GeometryInputState;
  readonly camera: GeometryCamera;
}

class SessionError extends Error {}
function fail(code = 'invalid_input'): never {
  throw new SessionError(code);
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
}
const exact = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  if (
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail('invalid_command');
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const encoder = new TextEncoder();
function copyJson(value: unknown): unknown {
  let remaining = 8192;
  const ancestors = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 20) fail();
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (input.length > 65536) fail();
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail();
      return input === 0 ? 0 : input;
    }
    if (!input || typeof input !== 'object' || ancestors.has(input)) return fail();
    const isArray = Array.isArray(input);
    if (!isArray && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 8192 || keys.some((key) => typeof key !== 'string')) fail();
    if (isArray && (keys.length !== input.length + 1 || input.length > 8192)) fail();
    ancestors.add(input);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      output[key as string] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(input);
    if (isArray) {
      if (Object.keys(output).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || +key >= input.length))
        fail();
      return Array.from({ length: input.length }, (_, index) => output[index]);
    }
    return output;
  };
  const copied = copy(value, 0);
  if (encoder.encode(JSON.stringify(copied)).byteLength > 64 * 1024) fail('state_bytes_exceeded');
  return copied;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const emptyAuxiliary = (): GeometryAuxiliaryStateV2 =>
  freeze({
    objects: [],
    measurements: [],
    relations: [],
    freedoms: [],
    presentation: { objects: [], measurements: [], relations: [] },
  });
const auxiliaryIds = (auxiliary: GeometryAuxiliaryStateV2): readonly string[] => [
  ...auxiliary.objects.map((item) => item.id),
  ...auxiliary.measurements.map((item) => item.id),
  ...auxiliary.relations.map((item) => item.id),
  ...auxiliary.freedoms.map((item) => item.id),
];
const visibleAuxiliaryIds = (auxiliary: GeometryAuxiliaryStateV2): readonly string[] => [
  ...auxiliary.objects.map((item) => item.id),
  ...auxiliary.measurements.map((item) => item.id),
  ...auxiliary.relations.map((item) => item.id),
];

interface Candidate {
  readonly composed: ComposedGeometryEnvelopeV2;
  readonly engine: GeometryEngine;
  readonly snapshot: GeometrySnapshot;
  readonly inputs: GeometryInputState;
}

export function createGeometrySessionV2(
  input: unknown,
  instanceId: string,
  options: {
    readonly engine?: GeometryEngine;
    readonly createEngine?: GeometryEngineFactoryV2;
    readonly initial?: GeometrySessionInitialV2;
    readonly explorationPolicy?: GeometryExplorationPolicyV2;
  } = {},
): GeometrySessionV2 {
  const parsed = parseGeometryEnvelopeV2(input);
  const envelope = parsed.envelope;
  if (options.explorationPolicy !== undefined && envelope.spec.authoring === undefined)
    fail('invalid_input');
  const auxiliaryEnvelope =
    options.explorationPolicy === undefined
      ? parsed
      : parseGeometryEnvelopeV2({
          ...envelope,
          spec: {
            ...envelope.spec,
            interaction: {
              ...envelope.spec.interaction,
              exploration: options.explorationPolicy,
            },
          },
        });
  if (typeof instanceId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(instanceId))
    fail('invalid_instance');
  const fingerprint = bytesToHex(sha256(encoder.encode(canonical(envelope))));
  const createEngine = options.createEngine ?? createGeometryEngine;
  const editableInputs = (
    composed: ComposedGeometryEnvelopeV2,
    inputs: GeometryInputState,
  ): GeometryInputState => ({
    parameters: Object.fromEntries(
      envelope.spec.interaction.parameters.map((id) => [id, inputs.parameters[id]]),
    ),
    freedoms: Object.fromEntries(
      composed.envelope.spec.interaction.freedoms.map((freedom) => [
        freedom.id,
        inputs.freedoms[freedom.id],
      ]),
    ),
  });
  const makeCandidate = (
    auxiliary: GeometryAuxiliaryStateV2,
    retained?: GeometryInputState,
    patch?: Partial<GeometryInputState>,
    complete?: GeometryInputState,
  ): Candidate => {
    const composed = composeGeometryEnvelopeV2(auxiliaryEnvelope, auxiliary);
    const candidate = createEngine(composed.envelope);
    try {
      let candidateSnapshot = candidate.snapshot();
      if (complete) {
        const expected = editableInputs(composed, candidateSnapshot.inputs);
        if (
          !same(Object.keys(complete.parameters).sort(), Object.keys(expected.parameters).sort()) ||
          !same(Object.keys(complete.freedoms).sort(), Object.keys(expected.freedoms).sort())
        )
          fail('unknown_input');
        candidateSnapshot = candidate.applyInputs(complete);
      } else {
        if (retained) {
          const initial = editableInputs(composed, candidateSnapshot.inputs);
          candidateSnapshot = candidate.applyInputs({
            parameters: Object.fromEntries(
              Object.keys(initial.parameters)
                .filter((id) => Object.hasOwn(retained.parameters, id))
                .map((id) => [id, retained.parameters[id]]),
            ),
            freedoms: Object.fromEntries(
              Object.keys(initial.freedoms)
                .filter((id) => Object.hasOwn(retained.freedoms, id))
                .map((id) => [id, retained.freedoms[id]]),
            ),
          });
        }
        if (
          patch &&
          (Object.keys(patch.parameters ?? {}).length || Object.keys(patch.freedoms ?? {}).length)
        )
          candidateSnapshot = candidate.applyInputs(patch);
      }
      return {
        composed,
        engine: candidate,
        snapshot: candidateSnapshot,
        inputs: editableInputs(composed, candidateSnapshot.inputs),
      };
    } catch (error) {
      try {
        candidate.dispose();
      } catch {}
      throw error;
    }
  };
  const initialAuxiliary = emptyAuxiliary();
  const initialComposed = composeGeometryEnvelopeV2(auxiliaryEnvelope, initialAuxiliary);
  let engine = options.engine ?? createEngine(initialComposed.envelope);
  let composed = initialComposed,
    snapshot = engine.snapshot();
  let initial: GeometrySessionStateV2;
  try {
    const authored = options.initial === undefined ? undefined : copyJson(options.initial);
    if (authored !== undefined) {
      record(authored);
      exact(authored, ['schemaVersion', 'instanceId', 'fingerprint', 'inputs', 'camera']);
      if (
        authored.schemaVersion !== 'reach-geometry-authored-snapshot/v1' ||
        authored.instanceId !== instanceId ||
        authored.fingerprint !== fingerprint
      )
        fail('fingerprint_mismatch');
      record(authored.inputs);
      exact(authored.inputs, ['parameters', 'freedoms']);
      const expected = editableInputs(composed, snapshot.inputs);
      const supplied = authored.inputs as unknown as GeometryInputState;
      if (
        !same(Object.keys(supplied.parameters).sort(), Object.keys(expected.parameters).sort()) ||
        !same(Object.keys(supplied.freedoms).sort(), Object.keys(expected.freedoms).sort())
      )
        fail('unknown_input');
      snapshot = engine.applyInputs(supplied);
      validateGeometryCamera(authored.camera, envelope.spec.dimension);
    }
    initial = freeze({
      schemaVersion: 'reach-geometry-state/v2',
      instanceId,
      fingerprint,
      inputs: editableInputs(composed, snapshot.inputs),
      auxiliary: initialAuxiliary,
      hiddenAuxiliary: [],
      selection: null,
      visibleGroups: envelope.spec.presentation.groups
        .filter((group) => envelope.spec.interaction.visibleGroups.includes(group.id))
        .map((group) => group.id),
      camera:
        authored === undefined
          ? envelope.spec.presentation.camera
          : (authored.camera as unknown as GeometryCamera),
    });
  } catch (error) {
    try {
      engine.dispose();
    } catch {}
    throw error;
  }
  let state = initial,
    revision = 0,
    geometryRevision = 0,
    modelRevision = 0,
    disposed = false;
  type HistoryEntry = {
    readonly before: GeometrySessionStateV2;
    readonly after: GeometrySessionStateV2;
    readonly group?: string;
  };
  const undo: HistoryEntry[] = [],
    redo: HistoryEntry[] = [];
  const groups = envelope.spec.presentation.groups.map((group) => group.id);
  function safely(operation: () => GeometrySessionResultV2): GeometrySessionResultV2;
  function safely(operation: () => GeometryDeleteImpactResultV2): GeometryDeleteImpactResultV2;
  function safely<T extends GeometrySessionResultV2 | GeometryDeleteImpactResultV2>(
    operation: () => T,
  ): T {
    if (disposed) return freeze({ ok: false, code: 'disposed' }) as T;
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
              : error instanceof GeometryContractError
                ? error.code
                : 'invalid_input',
      }) as T;
    }
  }
  const validateView = (candidate: GeometrySessionStateV2, current: ComposedGeometryEnvelopeV2) => {
    const selectable = new Set([
      ...envelope.spec.interaction.selectable,
      ...candidate.auxiliary.objects.map((object) => object.id),
    ]);
    if (candidate.selection !== null && !selectable.has(candidate.selection))
      fail('unknown_selection');
    if (
      new Set(candidate.visibleGroups).size !== candidate.visibleGroups.length ||
      candidate.visibleGroups.some((id) => !groups.includes(id))
    )
      fail('unknown_group');
    const allowedHidden = new Set(visibleAuxiliaryIds(candidate.auxiliary));
    if (
      new Set(candidate.hiddenAuxiliary).size !== candidate.hiddenAuxiliary.length ||
      candidate.hiddenAuxiliary.some((id) => !allowedHidden.has(id))
    )
      fail('unknown_auxiliary');
    validateGeometryCamera(candidate.camera, envelope.spec.dimension);
    if (current.auxiliary !== candidate.auxiliary && !same(current.auxiliary, candidate.auxiliary))
      fail();
  };
  const changeBetween = (
    before: GeometrySessionStateV2,
    after: GeometrySessionStateV2,
    kind: GeometrySessionChangeV2['kind'],
  ): GeometrySessionChangeV2 => ({
    kind,
    inputKeys: [
      ...new Set([
        ...Object.keys(before.inputs.parameters),
        ...Object.keys(after.inputs.parameters),
      ]),
    ]
      .filter((id) => before.inputs.parameters[id] !== after.inputs.parameters[id])
      .map((id) => `parameter:${id}`)
      .concat(
        [
          ...new Set([
            ...Object.keys(before.inputs.freedoms),
            ...Object.keys(after.inputs.freedoms),
          ]),
        ]
          .filter((id) => !same(before.inputs.freedoms[id], after.inputs.freedoms[id]))
          .map((id) => `freedom:${id}`),
      ),
    viewKeys: (['selection', 'visibleGroups', 'camera', 'hiddenAuxiliary'] as const).filter(
      (key) => !same(before[key], after[key]),
    ),
    structureKeys: [
      ...new Set([...auxiliaryIds(before.auxiliary), ...auxiliaryIds(after.auxiliary)]),
    ].filter((id) => {
      const entries = (auxiliary: GeometryAuxiliaryStateV2): readonly unknown[] => [
        auxiliary.objects.find((item) => item.id === id),
        auxiliary.measurements.find((item) => item.id === id),
        auxiliary.relations.find((item) => item.id === id),
        auxiliary.freedoms.find((item) => item.id === id),
        auxiliary.presentation.objects.find((item) => item.object === id),
        auxiliary.presentation.measurements.find((item) => item.measurement === id),
        auxiliary.presentation.relations.find((item) => item.relation === id),
      ];
      return !same(entries(before.auxiliary), entries(after.auxiliary));
    }),
  });
  const adopt = (
    requested: GeometrySessionStateV2,
    kind: GeometrySessionChangeV2['kind'],
    inputPatch: Partial<GeometryInputState> = {},
    history?: { readonly group?: string; readonly record: boolean },
    completeInputs = false,
  ): GeometrySessionResultV2 => {
    const before = state;
    const structureChanged = !same(before.auxiliary, requested.auxiliary);
    let nextEngine: GeometryEngine | undefined,
      nextComposed = composed,
      nextSnapshot = snapshot,
      inputs = before.inputs;
    let actual: GeometrySessionStateV2;
    try {
      const hasInputPatch =
        Object.keys(inputPatch.parameters ?? {}).length > 0 ||
        Object.keys(inputPatch.freedoms ?? {}).length > 0;
      if (structureChanged || completeInputs) {
        const candidate = makeCandidate(
          requested.auxiliary,
          completeInputs ? undefined : before.inputs,
          completeInputs ? undefined : inputPatch,
          completeInputs ? requested.inputs : undefined,
        );
        nextEngine = candidate.engine;
        nextComposed = candidate.composed;
        nextSnapshot = candidate.snapshot;
        inputs = candidate.inputs;
      } else {
        validateView(requested, composed);
        copyJson(requested);
        const inputChanged =
          Object.entries(inputPatch.parameters ?? {}).some(
            ([id, value]) => value !== before.inputs.parameters[id],
          ) ||
          Object.entries(inputPatch.freedoms ?? {}).some(
            ([id, value]) => !same(value, before.inputs.freedoms[id]),
          );
        if (hasInputPatch && inputChanged) {
          nextSnapshot = engine.applyInputs(inputPatch);
          inputs = editableInputs(composed, nextSnapshot.inputs);
        }
      }
      actual = freeze({ ...requested, inputs });
      validateView(actual, nextComposed);
      copyJson(actual);
      const changed = !same(before, actual);
      if (!changed) {
        try {
          nextEngine?.dispose();
        } catch {}
        return { ok: true, changed: false, revision };
      }
    } catch (error) {
      try {
        nextEngine?.dispose();
      } catch {}
      throw error;
    }
    let previousEngine: GeometryEngine | undefined;
    if (nextEngine) {
      previousEngine = engine;
      engine = nextEngine;
      composed = nextComposed;
    }
    snapshot = nextSnapshot;
    state = actual;
    revision++;
    const inputChanged = !same(before.inputs, actual.inputs);
    if (structureChanged || inputChanged) geometryRevision++;
    if (structureChanged) modelRevision++;
    if (history?.record) {
      const entry = { before, after: actual, ...(history.group ? { group: history.group } : {}) };
      const previous = undo.at(-1);
      if (history.group && previous?.group === history.group)
        undo[undo.length - 1] = { ...entry, before: previous.before };
      else undo.push(entry);
      if (undo.length > 50) undo.shift();
      redo.splice(0);
    }
    const result: GeometrySessionResultV2 = {
      ok: true,
      changed: true,
      revision,
      change: changeBetween(before, actual, kind),
    };
    try {
      previousEngine?.dispose();
    } catch {}
    return result;
  };
  const restoreHistory = (direction: 'undo' | 'redo'): GeometrySessionResultV2 => {
    const source = direction === 'undo' ? undo : redo,
      destination = direction === 'undo' ? redo : undo,
      entry = source.at(-1);
    if (!entry) return { ok: true, changed: false, revision };
    const target = direction === 'undo' ? entry.before : entry.after;
    const result = adopt(target, direction, {}, undefined, true);
    if (result.ok && result.changed) {
      source.pop();
      destination.push(entry);
    }
    return result;
  };
  const reset = (): GeometrySessionResultV2 =>
    safely(() => adopt(initial, 'reset', {}, { record: true }, true));
  return Object.freeze({
    getState: () => state,
    getComputedState: () =>
      freeze({
        ...snapshot,
        schemaVersion: 'reach-geometry-computed/v2' as const,
        instanceId,
        fingerprint,
        revision,
        geometryRevision,
        modelRevision,
        auxiliary: state.auxiliary,
        hiddenAuxiliary: state.hiddenAuxiliary,
        selection: state.selection,
        visibleGroups: state.visibleGroups,
        camera: state.camera,
        relations: evaluateGeometryRelations(
          composed.relations,
          snapshot,
          composed.envelope.spec.objects,
        ),
      }),
    getDeleteImpact: (id: string) =>
      safely(() => {
        if (typeof id !== 'string') fail();
        const impact = geometryAuxiliaryDeleteImpact(envelope, state.auxiliary, id);
        if (!impact) fail('unknown_auxiliary');
        return { ok: true, impact };
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
          'auxiliary',
          'hiddenAuxiliary',
          'selection',
          'visibleGroups',
          'camera',
        ]);
        if (value.schemaVersion !== 'reach-geometry-state/v2') fail('schema_mismatch');
        if (value.instanceId !== instanceId) fail('instance_mismatch');
        if (value.fingerprint !== fingerprint) fail('fingerprint_mismatch');
        record(value.inputs);
        exact(value.inputs, ['parameters', 'freedoms']);
        record(value.inputs.parameters);
        record(value.inputs.freedoms);
        const result = adopt(
          value as unknown as GeometrySessionStateV2,
          'batch',
          {},
          undefined,
          true,
        );
        if (result.ok) {
          undo.splice(0);
          redo.splice(0);
        }
        return result;
      }),
    applyCommand: (input: unknown) =>
      safely(() => {
        const value = copyJson(input);
        record(value);
        if (value.schemaVersion !== 'reach-geometry-command/v2') fail('schema_mismatch');
        const batched = Object.hasOwn(value, 'commands');
        if (batched) exact(value, ['schemaVersion', 'commands'], ['historyGroup']);
        const { schemaVersion: _, historyGroup, ...single } = value;
        if (
          historyGroup !== undefined &&
          (typeof historyGroup !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(historyGroup))
        )
          fail('invalid_history_group');
        const commands = batched ? value.commands : [single];
        if (!Array.isArray(commands) || commands.length < 1 || commands.length > 32)
          fail('invalid_command');
        if (
          commands.some(
            (command) =>
              command &&
              typeof command === 'object' &&
              ['undo', 'redo', 'reset'].includes(String((command as { kind?: unknown }).kind)),
          )
        ) {
          if (commands.length !== 1 || historyGroup !== undefined) fail('invalid_command');
          record(commands[0]);
          exact(commands[0], ['kind']);
          if (commands[0].kind === 'undo') return restoreHistory('undo');
          if (commands[0].kind === 'redo') return restoreHistory('redo');
          if (commands[0].kind === 'reset')
            return adopt(initial, 'reset', {}, { record: true }, true);
          fail('invalid_command');
        }
        let next = { ...state } as GeometrySessionStateV2;
        let auxiliary = state.auxiliary;
        const parameters: Record<string, number> = Object.create(null);
        const freedoms: Record<string, GeometryFreedomValueV2> = Object.create(null);
        const writes = new Map<string, unknown>();
        const write = (key: string, data: unknown) => {
          if (writes.has(key) && !same(writes.get(key), data)) fail('input_conflict');
          writes.set(key, data);
        };
        for (const command of commands) {
          record(command);
          if (command.kind === 'setParameter' || command.kind === 'setFreedom') {
            exact(command, ['kind', 'id', 'value']);
            if (typeof command.id !== 'string') fail();
            write(`${command.kind}:${command.id}`, command.value);
            if (command.kind === 'setParameter') parameters[command.id] = command.value as number;
            else freedoms[command.id] = command.value as GeometryFreedomValueV2;
          } else if (command.kind === 'select') {
            exact(command, ['kind', 'objectId']);
            write('selection', command.objectId);
            next = { ...next, selection: command.objectId as string | null };
          } else if (command.kind === 'setGroup') {
            exact(command, ['kind', 'id', 'visible']);
            if (
              typeof command.id !== 'string' ||
              !groups.includes(command.id) ||
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
          } else if (command.kind === 'addAuxiliary') {
            exact(command, ['kind', 'auxiliary']);
            record(command.auxiliary);
            exact(command.auxiliary, [
              'objects',
              'measurements',
              'relations',
              'freedoms',
              'presentation',
            ]);
            const addition = command.auxiliary as unknown as GeometryAuxiliaryStateV2;
            auxiliary = {
              objects: [...auxiliary.objects, ...addition.objects],
              measurements: [...auxiliary.measurements, ...addition.measurements],
              relations: [...auxiliary.relations, ...addition.relations],
              freedoms: [...auxiliary.freedoms, ...addition.freedoms],
              presentation: {
                objects: [...auxiliary.presentation.objects, ...addition.presentation.objects],
                measurements: [
                  ...auxiliary.presentation.measurements,
                  ...addition.presentation.measurements,
                ],
                relations: [
                  ...auxiliary.presentation.relations,
                  ...addition.presentation.relations,
                ],
              },
            };
          } else if (command.kind === 'deleteAuxiliary') {
            exact(command, ['kind', 'id']);
            if (typeof command.id !== 'string') fail();
            const impact = geometryAuxiliaryDeleteImpact(envelope, auxiliary, command.id);
            if (!impact) fail('unknown_auxiliary');
            auxiliary = removeGeometryAuxiliaryImpact(auxiliary, impact);
            next = {
              ...next,
              hiddenAuxiliary: next.hiddenAuxiliary.filter((id) => !impact.ids.includes(id)),
              selection: impact.objectIds.includes(next.selection ?? '') ? null : next.selection,
            };
          } else if (command.kind === 'setAuxiliaryHidden') {
            exact(command, ['kind', 'id', 'hidden']);
            if (typeof command.id !== 'string' || typeof command.hidden !== 'boolean') fail();
            if (!visibleAuxiliaryIds(auxiliary).includes(command.id)) fail('unknown_auxiliary');
            write(`hidden:${command.id}`, command.hidden);
            next = {
              ...next,
              hiddenAuxiliary: command.hidden
                ? [...new Set([...next.hiddenAuxiliary, command.id])]
                : next.hiddenAuxiliary.filter((id) => id !== command.id),
            };
          } else if (command.kind === 'clearAuxiliary') {
            exact(command, ['kind']);
            auxiliary = emptyAuxiliary();
            next = {
              ...next,
              selection: next.selection?.startsWith('L_') ? null : next.selection,
              hiddenAuxiliary: [],
            };
          } else fail('invalid_command');
        }
        next = { ...next, auxiliary };
        return adopt(
          next,
          batched ? 'batch' : (single.kind as GeometrySessionChangeV2['kind']),
          { parameters, freedoms },
          { record: true, ...(historyGroup ? { group: historyGroup as string } : {}) },
        );
      }),
    reset,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        engine.dispose();
        undo.splice(0);
        redo.splice(0);
      }
    },
  });
}
