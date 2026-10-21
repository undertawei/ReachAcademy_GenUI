import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeometryEnvelope, GeometrySpec } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { createGeometryEngine } from '../src/index.js';
import {
  createGeometrySession,
  isGeometryItemVisible,
  type GeometrySession,
  type GeometrySessionCommand,
} from '../src/session.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json', import.meta.url),
    'utf8',
  ),
) as { id: string; envelope: GeometryEnvelope }[];
const fixture = (
  id = 'G1-planar-dependencies',
  patch: Partial<GeometrySpec> = {},
): GeometryEnvelope => {
  const original = fixtures.find((item) => item.id === id)!.envelope;
  return { ...original, spec: { ...original.spec, ...patch } };
};
const sessions: GeometrySession[] = [];
const session = (envelope = fixture(), instanceId = 'geometry-a'): GeometrySession => {
  const result = createGeometrySession(envelope, instanceId);
  sessions.push(result);
  return result;
};
const command = (value: GeometrySessionCommand) => ({
  schemaVersion: 'reach-geometry-command/v1',
  ...value,
});
const batch = (...commands: GeometrySessionCommand[]) => ({
  schemaVersion: 'reach-geometry-command/v1',
  commands,
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
afterEach(() => {
  sessions.splice(0).forEach((value) => value.dispose());
});

describe('geometry session atomic commands', () => {
  it('uses the supplied authoritative engine once for a batch and reports every changed alias', () => {
    const envelope = fixture();
    const engine = createGeometryEngine(envelope);
    const apply = vi.spyOn(engine, 'applyInputs');
    const value = createGeometrySession(envelope, 'geometry-a', { engine });
    sessions.push(value);
    expect(
      value.applyCommand(
        batch(
          { kind: 'setParameter', id: 'theta', value: 1 },
          { kind: 'setFreedom', id: 'dragC', value: 1 },
          { kind: 'setFreedom', id: 'dragQ', value: { x: 2, y: 5 } },
          { kind: 'select', objectId: 'Q' },
        ),
      ),
    ).toEqual({
      ok: true,
      changed: true,
      revision: 1,
      change: {
        kind: 'batch',
        inputKeys: ['parameter:theta', 'freedom:dragQ', 'freedom:dragC'],
        viewKeys: ['selection'],
      },
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(value.getComputedState().measurements.height.value).toBe(5);
    expect(value.getComputedState().geometryRevision).toBe(1);
    expect(value.getState().inputs.parameters.theta).toBe(1);
    expect(value.getState().inputs.freedoms.dragC).toBe(1);
  });

  it('does not update the engine or emit change information for input and view no-ops', () => {
    const envelope = fixture();
    const engine = createGeometryEngine(envelope);
    const apply = vi.spyOn(engine, 'applyInputs');
    const value = createGeometrySession(envelope, 'geometry-a', { engine });
    sessions.push(value);
    for (const input of [
      command({ kind: 'setParameter', id: 'theta', value: 0 }),
      command({ kind: 'select', objectId: null }),
      command({ kind: 'setCamera', camera: envelope.spec.presentation.camera }),
      command({ kind: 'reset' }),
    ]) {
      expect(value.applyCommand(input)).toEqual({ ok: true, changed: false, revision: 0 });
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps geometry revisions stable for selection and camera changes', () => {
    const value = session();
    expect(value.applyCommand(command({ kind: 'select', objectId: 'AB' }))).toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(
      value.applyCommand(
        command({ kind: 'setCamera', camera: { kind: 'planar', bounds: [-10, -10, 10, 10] } }),
      ),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(value.getComputedState()).toMatchObject({
      revision: 2,
      geometryRevision: 0,
      selection: 'AB',
    });
  });

  it.each([
    batch(
      { kind: 'setParameter', id: 'theta', value: 1 },
      { kind: 'setFreedom', id: 'dragC', value: 2 },
    ),
    batch(
      { kind: 'setParameter', id: 'theta', value: 1 },
      { kind: 'setParameter', id: 'theta', value: 2 },
    ),
    batch(
      { kind: 'setFreedom', id: 'dragQ', value: { x: 1, y: 2 } },
      { kind: 'setFreedom', id: 'dragQ', value: { x: 2, y: 2 } },
    ),
  ])('rejects conflicting direct/aliased writes without mutation %#', (input) => {
    const value = session();
    const before = value.getComputedState();
    expect(value.applyCommand(input)).toEqual({ ok: false, code: 'input_conflict' });
    expect(value.getComputedState()).toEqual(before);
  });

  it.each([
    { kind: 'select', objectId: 'M' },
    { kind: 'setGroup', id: 'unknown', visible: true },
    { kind: 'setCamera', camera: { kind: 'planar', bounds: [0, 0, 0, 1] } },
    { kind: 'setCamera', camera: { kind: 'planar', bounds: [-1, -1, 1, 1], extra: 1 } },
    { kind: 'setFreedom', id: 'dragA', value: { x: 2 } },
    { kind: 'setParameter', id: 'theta', value: 99 },
  ])('validates the entire batch before changing geometry %#', (invalid) => {
    const value = session();
    const before = value.getComputedState();
    const result = value.applyCommand(
      batch({ kind: 'setParameter', id: 'theta', value: 1 }, invalid as GeometrySessionCommand),
    );
    expect(result.ok).toBe(false);
    expect(value.getComputedState()).toEqual(before);
  });

  it('supports plane freedoms and translating edges through the same input route', () => {
    const spatial = session(fixture('all-spatial-operators'));
    expect(
      spatial.applyCommand(
        command({ kind: 'setFreedom', id: 'dragOnPlane', value: { u: 2, v: 3 } }),
      ).ok,
    ).toBe(true);
    expect(spatial.getState().inputs.freedoms.dragOnPlane).toEqual({ u: 2, v: 3 });
    const translated = session(fixture('G5-translation'));
    const measurements = translated.getComputedState().measurements;
    expect(
      translated.applyCommand(
        command({ kind: 'setFreedom', id: 'dragEdge', value: { x: 3, y: 4 } }),
      ).ok,
    ).toBe(true);
    expect(translated.getState().inputs.parameters.dx).toBe(3);
    expect(translated.getComputedState().measurements).toEqual(measurements);
  });

  it('rejects undeclared fixed parameters and freedoms', () => {
    const original = fixture();
    const value = session(
      fixture('G1-planar-dependencies', {
        interaction: { ...original.spec.interaction, parameters: [] },
      }),
    );
    expect(value.getState().inputs.parameters).toEqual({});
    expect(value.applyCommand(command({ kind: 'setParameter', id: 'theta', value: 1 }))).toEqual({
      ok: false,
      code: 'unknown_input',
    });
    expect(
      value.applyCommand(command({ kind: 'setFreedom', id: 'M', value: { x: 1, y: 2 } })),
    ).toEqual({ ok: false, code: 'unknown_input' });
    expect(value.applyCommand(command({ kind: 'setFreedom', id: 'dragC', value: 1 })).ok).toBe(
      true,
    );
  });
});

describe('geometry session snapshots', () => {
  it('restores complete state in one update, without learner change metadata', () => {
    const source = session();
    source.applyCommand(
      batch(
        { kind: 'setParameter', id: 'theta', value: 1 },
        { kind: 'setFreedom', id: 'dragQ', value: { x: 2, y: 6 } },
        { kind: 'select', objectId: 'Q' },
        { kind: 'setCamera', camera: { kind: 'planar', bounds: [-10, -10, 10, 10] } },
      ),
    );
    const target = session();
    expect(target.setState(source.getState())).toEqual({ ok: true, changed: true, revision: 1 });
    expect(target.getComputedState()).toEqual(source.getComputedState());
    expect(target.setState(source.getState())).toEqual({ ok: true, changed: false, revision: 1 });
    expect(target.getState()).toEqual(source.getState());
  });

  it('restores valid degenerate inputs and recovers on reset', () => {
    const value = session();
    value.applyCommand(command({ kind: 'setFreedom', id: 'dragB', value: { x: 0, y: 0 } }));
    const saved = value.getState();
    expect(value.getComputedState().objects.AB.status).toBe('undefined');
    value.reset();
    expect(value.setState(saved)).toEqual({ ok: true, changed: true, revision: 3 });
    expect(value.getComputedState().objects.AB.status).toBe('undefined');
    value.reset();
    expect(value.getComputedState().objects.AB.status).toBe('valid');
  });

  it.each([
    (state: Record<string, unknown>) => {
      state.schemaVersion = 'reach-geometry-state/v2';
    },
    (state: Record<string, unknown>) => {
      state.instanceId = 'geometry-b';
    },
    (state: Record<string, unknown>) => {
      state.fingerprint = '0'.repeat(64);
    },
    (state: Record<string, unknown>) => {
      state.extra = true;
    },
    (state: Record<string, unknown>) => {
      delete state.camera;
    },
    (state: Record<string, unknown>) => {
      state.inputs = { parameters: {}, freedoms: {} };
    },
    (state: Record<string, unknown>) => {
      state.inputs = { parameters: { theta: 1, fixed: 1 }, freedoms: {} };
    },
    (state: Record<string, unknown>) => {
      state.camera = { kind: 'spatial' };
    },
    (state: Record<string, unknown>) => {
      state.selection = 'M';
    },
    (state: Record<string, unknown>) => {
      state.visibleGroups = ['unknown'];
    },
  ])('rejects tampered/incomplete snapshot without mutation %#', (tamper) => {
    const value = session();
    const before = value.getComputedState();
    const state = clone(value.getState()) as unknown as Record<string, unknown>;
    tamper(state);
    expect(value.setState(state).ok).toBe(false);
    expect(value.getComputedState()).toEqual(before);
  });

  it('rejects conflicting aliases in full snapshots', () => {
    const value = session();
    const before = value.getComputedState();
    const state = clone(value.getState());
    const input = { ...state, inputs: { ...state.inputs, parameters: { theta: 1 } } };
    expect(value.setState(input)).toEqual({ ok: false, code: 'input_conflict' });
    expect(value.getComputedState()).toEqual(before);
  });

  it('binds snapshots to normalized envelope content and instance id', () => {
    const source = session();
    const reordered = JSON.parse(
      JSON.stringify(fixture(), (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    ) as GeometryEnvelope;
    expect(session(reordered).getState().fingerprint).toBe(source.getState().fingerprint);
    expect(source.getState().fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const changed = session(
      fixture('G1-planar-dependencies', { ariaLabel: 'Different experiment' }),
    );
    expect(changed.setState(source.getState())).toEqual({
      ok: false,
      code: 'fingerprint_mismatch',
    });
    expect(session(fixture(), 'geometry-b').setState(source.getState())).toEqual({
      ok: false,
      code: 'instance_mismatch',
    });
  });

  it('returns deeply immutable data and does not retain caller command/snapshot references', () => {
    const value = session();
    const input = command({ kind: 'setFreedom', id: 'dragQ', value: { x: 2, y: 5 } });
    value.applyCommand(input);
    (input as unknown as { value: { y: number } }).value.y = 9;
    expect(value.getComputedState().measurements.height.value).toBe(5);
    expect(Object.isFrozen(value.getState().inputs.freedoms.dragQ)).toBe(true);
    expect(Object.isFrozen(value.getComputedState().objects.A.coordinates)).toBe(true);
    const saved = clone(value.getState());
    value.reset();
    value.setState(saved);
    (saved.inputs.freedoms.dragQ as { y: number }).y = 8;
    expect(value.getComputedState().measurements.height.value).toBe(5);
    expect(Object.keys(value.getState())).not.toContain('objects');
  });
});

describe('geometry visibility and reset', () => {
  const grouped = (): GeometryEnvelope => {
    const original = fixture();
    return fixture('G1-planar-dependencies', {
      presentation: {
        ...original.spec.presentation,
        objects: [
          { object: 'A', visible: false },
          { object: 'B', visible: true },
        ],
        measurements: [{ measurement: 'height', visible: false }],
        groups: [
          { id: 'first', objects: ['A', 'B'], measurements: ['height'] },
          { id: 'second', objects: ['B'], measurements: [] },
        ],
      },
      interaction: { ...original.spec.interaction, visibleGroups: ['second'] },
    });
  };
  it('implements explicit hidden precedence and group OR with ungrouped defaults', () => {
    const presentation = grouped().spec.presentation;
    expect(isGeometryItemVisible(presentation, ['first'], 'object', 'A')).toBe(false);
    expect(isGeometryItemVisible(presentation, [], 'object', 'B')).toBe(false);
    expect(isGeometryItemVisible(presentation, ['second'], 'object', 'B')).toBe(true);
    expect(isGeometryItemVisible(presentation, [], 'object', 'Q')).toBe(true);
    expect(isGeometryItemVisible(presentation, ['first'], 'measurement', 'height')).toBe(false);
  });
  it('allows toggling all declared groups and resets inputs, view, camera and selection', () => {
    const value = session(grouped());
    const initial = value.getState();
    value.applyCommand(
      batch(
        { kind: 'setGroup', id: 'first', visible: true },
        { kind: 'setGroup', id: 'second', visible: false },
        { kind: 'setParameter', id: 'theta', value: 1 },
        { kind: 'select', objectId: 'AB' },
        { kind: 'setCamera', camera: { kind: 'planar', bounds: [-10, -10, 10, 10] } },
      ),
    );
    expect(value.getState().visibleGroups).toEqual(['first']);
    expect(value.reset()).toMatchObject({ ok: true, changed: true, revision: 2 });
    expect(value.getState()).toEqual(initial);
    expect(value.getComputedState()).toMatchObject({ revision: 2, geometryRevision: 2 });
    expect(value.reset()).toEqual({ ok: true, changed: false, revision: 2 });
  });
});

describe('geometry public input hardening and lifecycle', () => {
  it.each([
    null,
    undefined,
    [],
    {},
    'reset',
    { schemaVersion: 'wrong', kind: 'reset' },
    { ...command({ kind: 'reset' }), extra: 1 },
    batch(),
    batch(...Array.from({ length: 33 }, () => ({ kind: 'reset' as const }))),
    batch({ kind: 'reset' }, { kind: 'select', objectId: null }),
    command({ kind: 'setParameter', id: 'theta', value: NaN }),
    command({ kind: 'setParameter', id: 'theta', value: Infinity }),
  ])('does not throw on malformed commands %#', (input) => {
    const value = session();
    const before = value.getComputedState();
    expect(value.applyCommand(input).ok).toBe(false);
    expect(value.getComputedState()).toEqual(before);
  });
  it('rejects getters, custom prototypes, cycles, symbols and sparse command arrays', () => {
    const value = session();
    const getter = vi.fn(() => 'reset');
    const accessor = {
      schemaVersion: 'reach-geometry-command/v1',
      get kind() {
        return getter();
      },
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(1);
    for (const input of [
      accessor,
      Object.create(command({ kind: 'reset' })),
      cycle,
      { ...command({ kind: 'reset' }), [Symbol('extra')]: 1 },
      { schemaVersion: 'reach-geometry-command/v1', commands: sparse },
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('hostile');
          },
        },
      ),
    ]) {
      expect(value.applyCommand(input).ok).toBe(false);
      expect(value.setState(input).ok).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects invalid spatial camera without modifying pending inputs', () => {
    const value = session(fixture('G3-pyramid'));
    const before = value.getComputedState();
    expect(
      value.applyCommand(
        batch(
          { kind: 'setParameter', id: 'h', value: 5 },
          {
            kind: 'setCamera',
            camera: {
              kind: 'spatial',
              projection: 'perspective',
              position: [0, 0, 1],
              target: [0, 0, 0],
              up: [0, 0, 1],
              zoom: 1,
            },
          },
        ),
      ).ok,
    ).toBe(false);
    expect(value.getComputedState()).toEqual(before);
  });
  it('disposes once and rejects all further mutations without throwing', () => {
    const envelope = fixture();
    const engine = createGeometryEngine(envelope);
    const dispose = vi.spyOn(engine, 'dispose');
    const value = createGeometrySession(envelope, 'geometry-a', { engine });
    const initial = value.getState();
    value.dispose();
    value.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(value.applyCommand(command({ kind: 'reset' }))).toEqual({ ok: false, code: 'disposed' });
    expect(value.setState(initial)).toEqual({ ok: false, code: 'disposed' });
    expect(value.reset()).toEqual({ ok: false, code: 'disposed' });
    expect(value.getState()).toBe(initial);
  });
});
