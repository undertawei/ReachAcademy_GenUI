import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GeometryAuxiliaryStateV2,
  GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { geometryAuthoringExplorationPolicyV2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { createGeometryEngine, type GeometryEngine } from '../src/index.js';
import {
  createGeometrySessionV2,
  type GeometrySessionCommandV2,
  type GeometrySessionV2,
} from '../src/sessionV2.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json', import.meta.url),
    'utf8',
  ),
) as { envelope: GeometryEnvelopeV2; auxiliary: GeometryAuxiliaryStateV2 };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const command = (value: GeometrySessionCommandV2) => ({
  schemaVersion: 'reach-geometry-command/v2' as const,
  ...value,
});
const sessions: GeometrySessionV2[] = [];
const session = (): GeometrySessionV2 => {
  const value = createGeometrySessionV2(fixture.envelope, 'geometry-v2');
  sessions.push(value);
  return value;
};

afterEach(() => sessions.splice(0).forEach((value) => value.dispose()));

describe('geometry v2 exploration sessions', () => {
  it('adopts a composed learner graph and evaluates measurements and relations', () => {
    const value = session();
    expect(value.getComputedState().relations.baseLines).toMatchObject({
      status: 'valid',
      classification: 'intersecting',
      intersectsDeclaredDomains: true,
    });

    expect(
      value.applyCommand(command({ kind: 'addAuxiliary', auxiliary: fixture.auxiliary })),
    ).toMatchObject({ ok: true, changed: true, revision: 1 });
    expect(value.getComputedState()).toMatchObject({
      geometryRevision: 1,
      modelRevision: 1,
      measurements: { L_height: { status: 'valid', value: 4 } },
      relations: {
        L_position: {
          status: 'valid',
          classification: 'intersecting',
          intersectsDeclaredDomains: true,
        },
      },
    });
    expect(
      value.applyCommand(command({ kind: 'setFreedom', id: 'L_dragOn', value: 0.75 })),
    ).toMatchObject({ ok: true, changed: true, revision: 2 });
    expect(value.getState().inputs.freedoms.L_dragOn).toBe(0.75);
  });

  it('deletes the auxiliary dependency closure and restores it in one undo', () => {
    const value = session();
    value.applyCommand(command({ kind: 'addAuxiliary', auxiliary: fixture.auxiliary }));
    expect(value.getDeleteImpact('L_M')).toEqual({
      ok: true,
      impact: {
        requestedId: 'L_M',
        objectIds: ['L_M', 'L_PM'],
        measurementIds: ['L_angle'],
        relationIds: ['L_position'],
        freedomIds: [],
        ids: ['L_M', 'L_PM', 'L_angle', 'L_position'],
      },
    });

    expect(value.applyCommand(command({ kind: 'deleteAuxiliary', id: 'L_M' }))).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(value.getState().auxiliary.objects.map((item) => item.id)).not.toContain('L_PM');
    expect(value.applyCommand(command({ kind: 'undo' }))).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(value.getState().auxiliary).toEqual(fixture.auxiliary);
  });

  it('disposes a failed candidate and leaves the authoritative engine untouched', () => {
    const engines: GeometryEngine[] = [];
    const factory = vi.fn((envelope) => {
      const engine = createGeometryEngine(envelope);
      vi.spyOn(engine, 'dispose');
      engines.push(engine);
      return engine;
    });
    const value = createGeometrySessionV2(fixture.envelope, 'geometry-v2', {
      createEngine: factory,
    });
    sessions.push(value);
    const before = value.getComputedState();
    expect(
      value.applyCommand({
        schemaVersion: 'reach-geometry-command/v2',
        commands: [
          { kind: 'addAuxiliary', auxiliary: fixture.auxiliary },
          { kind: 'setParameter', id: 'missing', value: 1 },
        ],
      }),
    ).toEqual({ ok: false, code: 'unknown_input' });
    expect(value.getComputedState()).toEqual(before);
    expect(engines).toHaveLength(2);
    expect(engines[0].dispose).not.toHaveBeenCalled();
    expect(engines[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed replacement when disposing the previous engine throws', () => {
    const engines: GeometryEngine[] = [];
    const factory = vi.fn((envelope) => {
      const engine = createGeometryEngine(envelope);
      vi.spyOn(engine, 'dispose');
      if (engines.length === 0)
        vi.mocked(engine.dispose).mockImplementation(() => {
          throw new Error('cleanup failed');
        });
      engines.push(engine);
      return engine;
    });
    const value = createGeometrySessionV2(fixture.envelope, 'geometry-v2', {
      createEngine: factory,
    });
    sessions.push(value);

    expect(
      value.applyCommand(command({ kind: 'addAuxiliary', auxiliary: fixture.auxiliary })),
    ).toMatchObject({ ok: true, changed: true, revision: 1 });
    expect(value.getComputedState()).toMatchObject({
      modelRevision: 1,
      measurements: { L_height: { status: 'valid', value: 4 } },
    });
    expect(engines[0].dispose).toHaveBeenCalledTimes(1);
    expect(engines[1].dispose).not.toHaveBeenCalled();
  });

  it('applies parameter and freedom commands on the current engine without rebuilding', () => {
    const envelope: GeometryEnvelopeV2 = {
      ...fixture.envelope,
      spec: {
        ...fixture.envelope.spec,
        parameters: [{ id: 'scale', initial: 1, min: 0, max: 10, step: 0.1 }],
        interaction: {
          ...fixture.envelope.spec.interaction,
          parameters: ['scale'],
        },
      },
    };
    const engines: GeometryEngine[] = [];
    const factory = vi.fn((definition) => {
      const engine = createGeometryEngine(definition);
      vi.spyOn(engine, 'applyInputs');
      vi.spyOn(engine, 'dispose');
      engines.push(engine);
      return engine;
    });
    const value = createGeometrySessionV2(envelope, 'geometry-v2', { createEngine: factory });
    sessions.push(value);
    expect(
      value.applyCommand(command({ kind: 'addAuxiliary', auxiliary: fixture.auxiliary })).ok,
    ).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
    vi.mocked(engines[1].applyInputs).mockClear();

    expect(
      value.applyCommand(command({ kind: 'setParameter', id: 'scale', value: 2 })),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      value.applyCommand(command({ kind: 'setFreedom', id: 'L_dragOn', value: 0.75 })),
    ).toMatchObject({ ok: true, changed: true });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(engines[1].applyInputs).toHaveBeenNthCalledWith(1, {
      parameters: { scale: 2 },
      freedoms: {},
    });
    expect(engines[1].applyInputs).toHaveBeenNthCalledWith(2, {
      parameters: {},
      freedoms: { L_dragOn: 0.75 },
    });
    expect(engines[1].dispose).not.toHaveBeenCalled();
    expect(value.getState().inputs).toMatchObject({
      parameters: { scale: 2 },
      freedoms: { L_dragOn: 0.75 },
    });
  });

  it('restores definitions, inputs and view without restoring undo history', () => {
    const source = session();
    source.applyCommand(command({ kind: 'addAuxiliary', auxiliary: fixture.auxiliary }));
    source.applyCommand(command({ kind: 'setFreedom', id: 'L_dragOn', value: 0.75 }));
    source.applyCommand(command({ kind: 'select', objectId: 'L_On' }));
    const saved = clone(source.getState());

    const target = session();
    expect(target.setState(saved)).toMatchObject({ ok: true, changed: true });
    expect(target.getState()).toEqual(saved);
    expect(target.getComputedState().objects.L_On.status).toBe('valid');
    expect(target.applyCommand(command({ kind: 'undo' }))).toEqual({
      ok: true,
      changed: false,
      revision: 1,
    });
  });

  it.each([null, 0, ''])(
    'rejects malformed persisted inputs %j without resetting state',
    (inputs) => {
      const value = session();
      value.applyCommand(command({ kind: 'addAuxiliary', auxiliary: fixture.auxiliary }));
      value.applyCommand(command({ kind: 'setFreedom', id: 'L_dragOn', value: 0.75 }));
      const before = value.getState();
      const malformed = { ...clone(before), inputs };

      expect(value.setState(malformed)).toEqual({ ok: false, code: 'invalid_input' });
      expect(value.getState()).toEqual(before);
    },
  );

  it('rejects policy and namespace violations without partial state changes', () => {
    const value = session();
    const before = value.getComputedState();
    const invalid: GeometryAuxiliaryStateV2 = {
      ...clone(fixture.auxiliary),
      objects: fixture.auxiliary.objects.map((object, index) =>
        index === 0 ? { ...object, id: 'teacher_id' } : object,
      ),
    };
    expect(value.applyCommand(command({ kind: 'addAuxiliary', auxiliary: invalid })).ok).toBe(
      false,
    );
    expect(value.getComputedState()).toEqual(before);
    expect(value.applyCommand(command({ kind: 'deleteAuxiliary', id: 'A' }))).toEqual({
      ok: false,
      code: 'unknown_auxiliary',
    });
  });

  it('uses an explicit authoring policy without changing the document fingerprint', () => {
    const envelope: GeometryEnvelopeV2 = {
      ...fixture.envelope,
      spec: {
        ...fixture.envelope.spec,
        interaction: {
          ...fixture.envelope.spec.interaction,
          exploration: {
            objectKinds: [],
            measurementKinds: [],
            relationKinds: [],
            referenceableObjects: ['A'],
            limits: { objects: 0, measurements: 0, relations: 0 },
            feedback: 'hidden',
          },
        },
      },
    };
    const auxiliary: GeometryAuxiliaryStateV2 = {
      objects: [{ id: 'L_edge', kind: 'segment', a: 'A', b: 'B' }],
      measurements: [],
      relations: [],
      freedoms: [],
      presentation: { objects: [{ object: 'L_edge' }], measurements: [], relations: [] },
    };
    const learner = createGeometrySessionV2(envelope, 'geometry-v2');
    const authoring = createGeometrySessionV2(envelope, 'geometry-v2', {
      explorationPolicy: geometryAuthoringExplorationPolicyV2(envelope),
    });
    sessions.push(learner, authoring);

    expect(learner.applyCommand(command({ kind: 'addAuxiliary', auxiliary })).ok).toBe(false);
    expect(authoring.applyCommand(command({ kind: 'addAuxiliary', auxiliary }))).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(authoring.getState().fingerprint).toBe(learner.getState().fingerprint);
    expect(authoring.getState().auxiliary.objects).toEqual(auxiliary.objects);
  });

  it('rejects a policy override when the source has no authoring binding', () => {
    const { authoring: _authoring, ...spec } = fixture.envelope.spec;
    const envelope = { ...fixture.envelope, spec };
    expect(() =>
      createGeometrySessionV2(envelope, 'geometry-v2', {
        explorationPolicy: fixture.envelope.spec.interaction.exploration,
      }),
    ).toThrow('invalid_input');
  });
});
