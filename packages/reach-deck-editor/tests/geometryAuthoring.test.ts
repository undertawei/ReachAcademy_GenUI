import scenario from '../../reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json';
import type { ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  applyGeometryEditProposal,
  deleteGeometryAuthoredItem,
  geometryEnvelopeFingerprint,
  inspectGeometryAuthoring,
  setGeometryAuthoredInitialState,
  updateGeometryAuthoredPresentation,
  updateGeometryExplorationPolicy,
  updateGeometryParameterAuthoring,
  type GeometryAuthoringEditProposal,
} from '../src/geometryAuthoring.js';

type InteractivePage = Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }>;

const emptyManifest = { schemaVersion: 'reach-interactive-event-manifest/v1' as const, events: [] };

function pageFor(envelope: unknown, revision = 3): InteractivePage {
  return {
    pageId: 'geometry-page',
    order: 1,
    revision,
    sceneType: 'interactive',
    title: 'Geometry',
    scene: {
      schemaVersion: 'reach-interactive-scene/v2',
      id: 'geometry-page',
      title: 'Geometry',
      sceneType: 'interactive',
      documentHtml: `<!doctype html><html><head></head><body><script type="application/json" data-reach-science-kit="geometry-main">${JSON.stringify(envelope)}</script><div data-reach-science-kit-target="geometry-main"></div></body></html>`,
      bridgeVersion: 'reach-interactive-bridge/v1',
      runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
      eventManifest: emptyManifest,
    },
  };
}

function stateFor(
  envelope: GeometryAuthoringEditProposal['envelope'],
  auxiliary: unknown = scenario.auxiliary,
): GeometryAuthoringEditProposal['state'] {
  const fingerprint = geometryEnvelopeFingerprint(envelope);
  return {
    schemaVersion: 'reach-geometry-state/v2',
    instanceId: 'geometry-main',
    fingerprint,
    inputs: { parameters: {}, freedoms: { L_dragOn: 0.5 } },
    auxiliary,
    hiddenAuxiliary: [],
    selection: null,
    visibleGroups: [],
    camera: envelope.spec.presentation.camera,
  };
}

function proposalFor(
  page: InteractivePage,
  envelope = scenario.envelope as unknown as GeometryAuthoringEditProposal['envelope'],
): GeometryAuthoringEditProposal {
  const fingerprint = geometryEnvelopeFingerprint(envelope);
  return {
    schemaVersion: 'reach-geometry-edit-proposal/v1',
    pageId: page.pageId,
    sourceRevision: page.revision,
    instanceId: 'geometry-main',
    fingerprint,
    envelope,
    state: stateFor(envelope),
    wireSequence: 4,
  };
}

function authoredSnapshotScript(
  envelope = scenario.envelope as unknown as GeometryAuthoringEditProposal['envelope'],
): string {
  return `<script type="application/json" data-reach-geometry-snapshot="geometry-main">${JSON.stringify(
    {
      schemaVersion: 'reach-geometry-authored-snapshot/v1',
      instanceId: 'geometry-main',
      fingerprint: geometryEnvelopeFingerprint(envelope),
      inputs: { parameters: {}, freedoms: {} },
      camera: envelope.spec.presentation.camera,
    },
  )}</script>`;
}

describe('geometry authoring document operations', () => {
  it('detects explicit v2 authoring bindings and leaves an unbound marker read-only', () => {
    const editable = inspectGeometryAuthoring(pageFor(scenario.envelope).scene.documentHtml);
    expect(editable).toMatchObject({ editable: true, hasGeometryV2: true });

    const envelope = structuredClone(scenario.envelope) as Record<string, any>;
    delete (envelope.spec as Record<string, unknown>).authoring;
    const readOnly = inspectGeometryAuthoring(pageFor(envelope).scene.documentHtml);
    expect(readOnly).toMatchObject({ editable: false, hasGeometryV2: true });
    expect(() =>
      applyGeometryEditProposal({
        page: pageFor(envelope),
        proposal: proposalFor(
          pageFor(envelope),
          envelope as unknown as GeometryAuthoringEditProposal['envelope'],
        ),
      }),
    ).toThrow(/authoring bindings/i);
  });

  it('promotes temporary auxiliary definitions without implicitly creating an initial snapshot', () => {
    const page = pageFor(scenario.envelope);
    const updated = applyGeometryEditProposal({ page, proposal: proposalFor(page) });
    const reopened = inspectGeometryAuthoring(updated.scene.documentHtml);
    const instance = reopened.instances[0]!;

    expect(instance.envelope.spec.objects.map(({ id }) => id)).toContain('A_M');
    expect(instance.envelope.spec.objects.map(({ id }) => id)).not.toContain('L_M');
    expect(instance.envelope.spec.authoring?.deletable.objects).toContain('A_M');
    expect(instance.envelope.spec.measurements.map(({ id }) => id)).toContain('A_height');
    expect(instance.snapshot).toBeUndefined();
    expect(updated.scene.documentHtml).not.toContain('data-reach-geometry-snapshot');
  });

  it('promotes consecutive constructions that reference the previous authored object', () => {
    const initial = pageFor(scenario.envelope);
    const first = applyGeometryEditProposal({ page: initial, proposal: proposalFor(initial) });
    const firstInstance = inspectGeometryAuthoring(first.scene.documentHtml).instances[0]!;
    const learnerPolicy = structuredClone(firstInstance.envelope.spec.interaction.exploration);
    const secondAuxiliary = {
      objects: [{ id: 'L_next', kind: 'segment' as const, a: 'A_M', b: 'P' }],
      measurements: [],
      relations: [],
      freedoms: [],
      presentation: {
        objects: [{ object: 'L_next', lineStyle: 'dashed' as const }],
        measurements: [],
        relations: [],
      },
    };
    const secondProposal = {
      ...proposalFor(first, firstInstance.envelope),
      state: stateFor(firstInstance.envelope, secondAuxiliary),
    };
    const second = applyGeometryEditProposal({ page: first, proposal: secondProposal });
    const secondInstance = inspectGeometryAuthoring(second.scene.documentHtml).instances[0]!;
    const next = secondInstance.envelope.spec.objects.find(({ id }) => id === 'A_next');

    expect(next).toMatchObject({ kind: 'segment', a: 'A_M', b: 'P' });
    expect(secondInstance.envelope.spec.authoring?.editable.objects).toContain('A_next');
    expect(secondInstance.envelope.spec.authoring?.deletable.objects).toContain('A_next');
    expect(secondInstance.envelope.spec.interaction.exploration).toEqual(learnerPolicy);
    expect(() => applyGeometryEditProposal({ page: second, proposal: secondProposal })).toThrow(
      /no longer matches/i,
    );
  });

  it('rejects stale revisions and stale envelope fingerprints', () => {
    const page = pageFor(scenario.envelope);
    const staleRevision = { ...proposalFor(page), sourceRevision: page.revision - 1 };
    expect(() => applyGeometryEditProposal({ page, proposal: staleRevision })).toThrow(
      /stale page/i,
    );

    const staleFingerprint = { ...proposalFor(page), fingerprint: 'a'.repeat(64) };
    expect(() => applyGeometryEditProposal({ page, proposal: staleFingerprint })).toThrow(
      /no longer matches/i,
    );
  });

  it('validates properties and policy as complete envelope candidates', () => {
    const page = pageFor(scenario.envelope);
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    const styled = updateGeometryAuthoredPresentation({
      page,
      instanceId: instance.instanceId,
      expectedFingerprint: instance.fingerprint,
      category: 'objects',
      id: 'AP',
      patch: { label: 'helper', colorToken: 'success', lineStyle: 'dotted', visible: false },
    });
    const styledInstance = inspectGeometryAuthoring(styled.scene.documentHtml).instances[0]!;
    expect(
      styledInstance.envelope.spec.presentation.objects.find(({ object }) => object === 'AP'),
    ).toMatchObject({
      label: 'helper',
      colorToken: 'success',
      lineStyle: 'dotted',
      visible: false,
    });

    const policy = {
      ...styledInstance.envelope.spec.interaction.exploration,
      feedback: 'hidden' as const,
      limits: { objects: 3, measurements: 2, relations: 1 },
    };
    const policyUpdated = updateGeometryExplorationPolicy({
      page: styled,
      instanceId: styledInstance.instanceId,
      expectedFingerprint: styledInstance.fingerprint,
      policy,
    });
    expect(
      inspectGeometryAuthoring(policyUpdated.scene.documentHtml).instances[0]!.envelope.spec
        .interaction.exploration,
    ).toMatchObject(policy);
  });

  it('accepts four measurement decimals and rejects five through the canonical contract', () => {
    const promoted = applyGeometryEditProposal({
      page: pageFor(scenario.envelope),
      proposal: proposalFor(pageFor(scenario.envelope)),
    });
    const instance = inspectGeometryAuthoring(promoted.scene.documentHtml).instances[0]!;
    const four = updateGeometryAuthoredPresentation({
      page: promoted,
      instanceId: instance.instanceId,
      expectedFingerprint: instance.fingerprint,
      category: 'measurements',
      id: 'A_height',
      patch: { decimals: 4 },
    });
    expect(
      inspectGeometryAuthoring(
        four.scene.documentHtml,
      ).instances[0]!.envelope.spec.presentation.measurements.find(
        ({ measurement }) => measurement === 'A_height',
      ),
    ).toMatchObject({ decimals: 4 });
    expect(() =>
      updateGeometryAuthoredPresentation({
        page: promoted,
        instanceId: instance.instanceId,
        expectedFingerprint: instance.fingerprint,
        category: 'measurements',
        id: 'A_height',
        patch: { decimals: 5 },
      }),
    ).toThrow(/invalid_value/i);
  });

  it('blocks deletion of external references and permits bound deletable items', () => {
    const page = pageFor(scenario.envelope);
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    expect(() =>
      deleteGeometryAuthoredItem({
        page,
        instanceId: instance.instanceId,
        expectedFingerprint: instance.fingerprint,
        category: 'objects',
        id: 'AP',
      }),
    ).toThrow(/externally referenced|not deletable/i);

    const promoted = applyGeometryEditProposal({ page, proposal: proposalFor(page) });
    const promotedInstance = inspectGeometryAuthoring(promoted.scene.documentHtml).instances[0]!;
    const deleted = deleteGeometryAuthoredItem({
      page: promoted,
      instanceId: promotedInstance.instanceId,
      expectedFingerprint: promotedInstance.fingerprint,
      category: 'relations',
      id: 'A_position',
    });
    expect(
      inspectGeometryAuthoring(deleted.scene.documentHtml).instances[0]!.envelope.spec.relations,
    ).not.toContainEqual(expect.objectContaining({ id: 'A_position' }));
  });

  it('sets bound parameter/freedom/camera initials and reopens the saved snapshot', () => {
    const envelope = structuredClone(scenario.envelope) as Record<string, any>;
    envelope.spec.parameters = [{ id: 'ratio', initial: 0.25, min: 0, max: 1, step: 0.05 }];
    envelope.spec.objects.push({
      id: 'Q',
      kind: 'pointOnLine',
      line: 'AB',
      t: { parameter: 'ratio' },
    });
    envelope.spec.presentation.objects.push({ object: 'Q', label: 'Q' });
    envelope.spec.interaction.parameters = ['ratio'];
    envelope.spec.interaction.freedoms = [
      { id: 'moveQ', kind: 'line', object: 'Q', range: { min: 0, max: 1, step: 0.05 } },
    ];
    envelope.spec.interaction.selectable.push('Q');
    envelope.spec.authoring.editable.parameters = ['ratio'];
    envelope.spec.authoring.editable.freedoms = ['moveQ'];
    const page = pageFor(envelope);
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    const state = {
      ...stateFor(instance.envelope, {
        objects: [],
        measurements: [],
        relations: [],
        freedoms: [],
        presentation: { objects: [], measurements: [], relations: [] },
      }),
      inputs: { parameters: { ratio: 0.8 }, freedoms: { moveQ: 0.8 } },
      camera: { kind: 'planar' as const, bounds: [-4, -3, 10, 8] as const },
    };
    const updated = setGeometryAuthoredInitialState({
      page,
      instanceId: instance.instanceId,
      expectedFingerprint: instance.fingerprint,
      state,
    });
    const reopened = inspectGeometryAuthoring(updated.scene.documentHtml).instances[0]!;
    expect(reopened.envelope.spec.parameters[0]?.initial).toBe(0.8);
    expect(reopened.envelope.spec.objects.find(({ id }) => id === 'Q')).toMatchObject({
      t: { parameter: 'ratio' },
    });
    expect(reopened.envelope.spec.presentation.camera).toEqual(state.camera);
    expect(reopened.snapshot?.inputs).toEqual(state.inputs);
  });

  it('does not detach a freedom from an unbound parameter alias', () => {
    const envelope = structuredClone(scenario.envelope) as Record<string, any>;
    envelope.spec.parameters = [{ id: 'ratio', initial: 0.25, min: 0, max: 1, step: 0.05 }];
    envelope.spec.objects.push({
      id: 'Q',
      kind: 'pointOnLine',
      line: 'AB',
      t: { parameter: 'ratio' },
    });
    envelope.spec.presentation.objects.push({ object: 'Q' });
    envelope.spec.interaction.parameters = ['ratio'];
    envelope.spec.interaction.freedoms = [
      { id: 'moveQ', kind: 'line', object: 'Q', range: { min: 0, max: 1, step: 0.05 } },
    ];
    envelope.spec.interaction.selectable.push('Q');
    envelope.spec.authoring.editable.freedoms = ['moveQ'];
    const page = pageFor(envelope);
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    const state = {
      ...stateFor(instance.envelope, {
        objects: [],
        measurements: [],
        relations: [],
        freedoms: [],
        presentation: { objects: [], measurements: [], relations: [] },
      }),
      inputs: { parameters: { ratio: 0.8 }, freedoms: { moveQ: 0.8 } },
    };
    expect(() =>
      setGeometryAuthoredInitialState({
        page,
        instanceId: instance.instanceId,
        expectedFingerprint: instance.fingerprint,
        state,
      }),
    ).toThrow(/unbound parameter alias/i);
  });

  it('changes learner parameter permission/range without widening the teacher binding', () => {
    const envelope = structuredClone(scenario.envelope) as Record<string, any>;
    envelope.spec.parameters = [{ id: 'ratio', initial: 0.25, min: 0, max: 1, step: 0.05 }];
    envelope.spec.objects.push({
      id: 'Q',
      kind: 'pointOnLine',
      line: 'AB',
      t: { parameter: 'ratio' },
    });
    envelope.spec.presentation.objects.push({ object: 'Q' });
    envelope.spec.interaction.parameters = ['ratio'];
    envelope.spec.interaction.freedoms = [
      { id: 'moveQ', kind: 'line', object: 'Q', range: { min: 0, max: 1, step: 0.05 } },
    ];
    envelope.spec.interaction.selectable.push('Q');
    envelope.spec.authoring.editable.parameters = ['ratio'];
    const page = pageFor(envelope);
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    const updated = updateGeometryParameterAuthoring({
      page,
      instanceId: instance.instanceId,
      expectedFingerprint: instance.fingerprint,
      settings: [{ id: 'ratio', learnerEditable: false, min: 0, max: 0.8, step: 0.1 }],
    });
    const reopened = inspectGeometryAuthoring(updated.scene.documentHtml).instances[0]!;
    expect(reopened.envelope.spec.interaction.parameters).toEqual([]);
    expect(reopened.envelope.spec.parameters[0]).toMatchObject({ min: 0, max: 0.8, step: 0.1 });
    expect(reopened.envelope.spec.interaction.freedoms[0]).toMatchObject({
      range: { min: 0, max: 0.8, step: 0.1 },
    });
    expect(reopened.envelope.spec.authoring?.editable.parameters).toEqual(['ratio']);
  });

  it('rejects malformed snapshot markers instead of silently ignoring them', () => {
    const page = pageFor(scenario.envelope);
    const malformed = {
      ...page,
      scene: {
        ...page.scene,
        documentHtml: page.scene.documentHtml.replace(
          '</script><div',
          '</script><script type="application/json" data-reach-geometry-snapshot="geometry-main">{}</script><div',
        ),
      },
    };
    expect(() => inspectGeometryAuthoring(malformed.scene.documentHtml)).toThrow(/snapshot shape/i);
  });

  it('accepts an authored snapshot only immediately after its v2 geometry marker', () => {
    const page = pageFor(scenario.envelope);
    const snapshot = authoredSnapshotScript();
    const afterGeometry = page.scene.documentHtml.replace(
      '</script><div',
      `</script>${snapshot}<div`,
    );
    expect(inspectGeometryAuthoring(afterGeometry).instances[0]?.snapshot).toBeDefined();

    const beforeGeometry = page.scene.documentHtml.replace(
      '<script type="application/json" data-reach-science-kit="geometry-main">',
      `${snapshot}<script type="application/json" data-reach-science-kit="geometry-main">`,
    );
    expect(() => inspectGeometryAuthoring(beforeGeometry)).toThrow(/must immediately follow/i);
    for (const separator of [' ', '\n', '&nbsp;', '\u00a0', '\ufeff', '\u001c']) {
      expect(() =>
        inspectGeometryAuthoring(afterGeometry.replace(snapshot, `${separator}${snapshot}`)),
      ).toThrow(/must immediately follow/i);
    }
  });

  it('rejects an authored snapshot whose camera does not match the geometry dimension', () => {
    const page = pageFor(scenario.envelope);
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    const snapshot = {
      schemaVersion: 'reach-geometry-authored-snapshot/v1',
      instanceId: instance.instanceId,
      fingerprint: instance.fingerprint,
      inputs: { parameters: {}, freedoms: {} },
      camera: {
        kind: 'spatial',
        projection: 'perspective',
        position: [4, 4, 4],
        target: [0, 0, 0],
        up: [0, 1, 0],
        zoom: 1,
      },
    };
    const invalid = page.scene.documentHtml.replace(
      '</script><div',
      `</script><script type="application/json" data-reach-geometry-snapshot="${instance.instanceId}">${JSON.stringify(snapshot)}</script><div`,
    );

    expect(() => inspectGeometryAuthoring(invalid)).toThrow(/snapshot exceeds its bindings/i);
  });

  it('rejects a policy with bad references through the v2 parser', () => {
    const page = pageFor(scenario.envelope);
    const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances[0]!;
    expect(() =>
      updateGeometryExplorationPolicy({
        page,
        instanceId: instance.instanceId,
        expectedFingerprint: instance.fingerprint,
        policy: {
          ...instance.envelope.spec.interaction.exploration,
          referenceableObjects: ['missing'],
        },
      }),
    ).toThrow(/unknown_reference/i);
  });
});
