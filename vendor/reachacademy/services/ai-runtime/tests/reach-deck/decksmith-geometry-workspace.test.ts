import { readFileSync } from 'node:fs';

import { createBlankReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import type { GeometryEnvelope } from '@reachany/reach-deck-dsl/euclidean-geometry';
import type { GeometryEnvelopeV2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { createGeometrySessionV2 } from '@reachany/reach-deck-geometry/session-v2';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

import { interactiveScene } from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';
import { DecksmithInteractiveWorkspace } from '../../lib/reach-deck/decksmith/interactive-workspace.js';
import { DecksmithDocumentSession } from '../../lib/reach-deck/decksmith/session.js';

const v1 = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json',
      import.meta.url,
    ),
    'utf8',
  ),
)[0].envelope as GeometryEnvelope;
const v2 = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json',
      import.meta.url,
    ),
    'utf8',
  ),
).envelope as GeometryEnvelopeV2;

function authoredSnapshot(envelope: GeometryEnvelopeV2) {
  const session = createGeometrySessionV2(envelope, 'geometry');
  try {
    const state = session.getState();
    return {
      schemaVersion: 'reach-geometry-authored-snapshot/v1',
      instanceId: 'geometry',
      fingerprint: state.fingerprint,
      inputs: state.inputs,
      camera: state.camera,
    };
  } finally {
    session.dispose();
  }
}

function html(envelope: GeometryEnvelope | GeometryEnvelopeV2, includeSnapshot = false): string {
  const snapshot =
    includeSnapshot && envelope.kitVersion === 2
      ? `<script type="application/json" data-reach-geometry-snapshot="geometry">${JSON.stringify(authoredSnapshot(envelope))}</script>`
      : '';
  return `<!doctype html><html><head></head><body><main data-reach-science-kit-target="geometry"></main><script type="application/json" data-reach-science-kit="geometry">${JSON.stringify(envelope)}</script>${snapshot}<script>const R=ReachInteractive,K=ReachScienceKits;let I=false;addEventListener('reach-interactive-initialize',e=>{if(I)return;I=true;const d=e.detail,s=d?.restoredSnapshot;const r=!!(s?.kit&&K.setState('geometry',s.kit)===true);R.ready(d?.restoreToken===undefined?{restored:r}:{restored:r,restoreToken:d.restoreToken});});</script></body></html>`;
}

function documentWith(
  envelope: GeometryEnvelope | GeometryEnvelopeV2,
  includeSnapshot = false,
): ReachDeckDocument {
  const document = createBlankReachDeckDocument({ id: 'geometry-deck', title: 'Geometry' });
  const pageId = document.pages[0]!.pageId;
  return {
    ...document,
    pages: [
      {
        pageId,
        order: 1,
        revision: 3,
        sceneType: 'interactive',
        title: 'Geometry',
        scene: {
          ...interactiveScene(pageId),
          title: 'Geometry',
          documentHtml: html(envelope, includeSnapshot),
          runtimeDependencies: [
            {
              id:
                envelope.kitVersion === 2
                  ? `geometry-euclidean-${envelope.spec.dimension}d-v2`
                  : `geometry-euclidean-${envelope.spec.dimension}d`,
              version: '1.0.0',
            },
          ],
        },
      },
    ],
    nativeSlides: [],
  } as ReachDeckDocument;
}

function workspaceFor(envelope: GeometryEnvelope | GeometryEnvelopeV2, includeSnapshot = false) {
  return workspaceForDocument(documentWith(envelope, includeSnapshot));
}

function workspaceForDocument(document: ReachDeckDocument) {
  const runtime =
    document.pages[0]!.sceneType === 'interactive'
      ? document.pages[0]!.scene.runtimeDependencies![0]!
      : undefined;
  const session = new DecksmithDocumentSession(document, 'reach-deck-decksmith/v2', {
    interactiveValidationOptions: {
      scientificCapabilityPolicy: 'normal',
      allowedRuntimeDependencies: runtime === undefined ? [] : [runtime],
    },
  });
  return {
    document,
    pageId: document.pages[0]!.pageId,
    session,
    workspace: new DecksmithInteractiveWorkspace(session),
  };
}

describe('Decksmith structured geometry working copy', () => {
  it('inspects v1 and v2 with their exact runtime pins and never upgrades v1 implicitly', async () => {
    const legacy = workspaceFor(v1);
    const legacyInspection = legacy.workspace.inspectGeometry(legacy.pageId);
    expect(legacyInspection.instances[0]).toMatchObject({
      kitVersion: 1,
      runtimeDependency: { id: 'geometry-euclidean-2d', version: '1.0.0' },
      editable: false,
      readOnlyReason: 'legacy-v1',
    });
    await expect(
      legacy.workspace.proposeGeometryEdit({
        pageId: legacy.pageId,
        instanceId: 'geometry',
        expectedHtmlSha256: legacyInspection.htmlSha256,
        envelope: v2,
      }),
    ).rejects.toThrow('GEOMETRY_EDIT_LEGACY_V1');
    expect(legacy.session.changed).toBe(false);

    const current = workspaceFor(v2);
    expect(current.workspace.inspectGeometry(current.pageId).instances[0]).toMatchObject({
      kitVersion: 2,
      runtimeDependency: { id: 'geometry-euclidean-2d-v2', version: '1.0.0' },
      editable: true,
    });
  });

  it('accepts a bound v2 policy/presentation proposal only in the working copy before commit', async () => {
    const { pageId, session, workspace } = workspaceFor(v2);
    const inspection = workspace.inspectGeometry(pageId);
    const envelope = structuredClone(v2) as any;
    envelope.spec.presentation.objects = envelope.spec.presentation.objects.map((entry: any) =>
      entry.object === 'AP' ? { ...entry, label: 'teacher line', lineStyle: 'dashed' } : entry,
    );
    envelope.spec.interaction.exploration = {
      ...envelope.spec.interaction.exploration,
      feedback: 'immediate',
    };
    const result = await workspace.proposeGeometryEdit({
      pageId,
      instanceId: 'geometry',
      expectedHtmlSha256: inspection.htmlSha256,
      envelope,
    });
    expect(result).toMatchObject({ check: { valid: true }, previousSha256: inspection.htmlSha256 });
    expect(result.sha256).not.toBe(inspection.htmlSha256);
    expect(session.changed).toBe(false);
    expect(session.readPageView(pageId).revision).toBe(3);

    await expect(
      workspace.proposeGeometryEdit({
        pageId,
        instanceId: 'geometry',
        expectedHtmlSha256: inspection.htmlSha256,
        envelope,
      }),
    ).rejects.toThrow('GEOMETRY_EDIT_STALE');
    expect(await workspace.commit({ pageId })).toMatchObject({ committed: true, revision: 4 });
    expect(session.changed).toBe(true);
  });

  it('allows new teacher-owned definitions only with derived editable/deletable bindings', async () => {
    const { pageId, workspace } = workspaceFor(v2);
    const inspection = workspace.inspectGeometry(pageId);
    const envelope = structuredClone(v2) as any;
    envelope.spec.objects.push({ id: 'teacherMid', kind: 'midpoint', a: 'A', b: 'B' });
    envelope.spec.presentation.objects.push({ object: 'teacherMid', label: 'M' });
    envelope.spec.interaction.selectable.push('teacherMid');
    envelope.spec.authoring!.editable.objects.push('teacherMid');
    envelope.spec.authoring!.deletable.objects.push('teacherMid');
    expect(
      (
        await workspace.proposeGeometryEdit({
          pageId,
          instanceId: 'geometry',
          expectedHtmlSha256: inspection.htmlSha256,
          envelope,
        })
      ).check.valid,
    ).toBe(true);
  });

  it('keeps the separate authored snapshot valid or rejects an edit that would discard it', async () => {
    const current = workspaceFor(v2, true);
    const inspection = current.workspace.inspectGeometry(current.pageId);
    expect(inspection.instances[0]?.hasAuthoredSnapshot).toBe(true);
    const envelope = structuredClone(v2) as any;
    envelope.spec.interaction.exploration.feedback = 'immediate';
    await current.workspace.proposeGeometryEdit({
      pageId: current.pageId,
      instanceId: 'geometry',
      expectedHtmlSha256: inspection.htmlSha256,
      envelope,
    });
    const parsed = new Window().document;
    parsed.documentElement.innerHTML = current.workspace.read(current.pageId);
    const snapshot = JSON.parse(
      parsed.querySelector('[data-reach-geometry-snapshot]')?.textContent ?? '',
    );
    const session = createGeometrySessionV2(envelope, 'geometry');
    expect(snapshot.fingerprint).toBe(session.getState().fingerprint);
    session.dispose();

    const incompatible = workspaceFor(v2, true);
    const baseline = incompatible.workspace.inspectGeometry(incompatible.pageId);
    const withFreedom = structuredClone(v2) as any;
    withFreedom.spec.objects.push({ id: 'teacherPoint', kind: 'freePoint', x: 1, y: 1 });
    withFreedom.spec.presentation.objects.push({ object: 'teacherPoint', label: 'T' });
    withFreedom.spec.interaction.selectable.push('teacherPoint');
    withFreedom.spec.interaction.freedoms.push({
      id: 'teacherFreedom',
      kind: 'freePoint',
      object: 'teacherPoint',
      x: { min: -2, max: 2, step: 0.1 },
      y: { min: -2, max: 2, step: 0.1 },
    });
    withFreedom.spec.authoring.editable.objects.push('teacherPoint');
    withFreedom.spec.authoring.editable.freedoms.push('teacherFreedom');
    withFreedom.spec.authoring.deletable.objects.push('teacherPoint');
    await expect(
      incompatible.workspace.proposeGeometryEdit({
        pageId: incompatible.pageId,
        instanceId: 'geometry',
        expectedHtmlSha256: baseline.htmlSha256,
        envelope: withFreedom,
      }),
    ).rejects.toThrow('GEOMETRY_SNAPSHOT_INVALID');
  });

  it('accepts a snapshot after its v2 marker and rejects the same snapshot before it', () => {
    const trailing = workspaceFor(v2, true);
    expect(() => trailing.workspace.inspectGeometry(trailing.pageId)).not.toThrow();

    const document = documentWith(v2, true);
    const page = document.pages[0]!;
    if (page.sceneType !== 'interactive') throw new Error('expected interactive page');
    const parsed = new Window().document;
    parsed.documentElement.innerHTML = page.scene.documentHtml;
    const marker = parsed.querySelector('[data-reach-science-kit="geometry"]');
    const snapshot = parsed.querySelector('[data-reach-geometry-snapshot="geometry"]');
    if (marker === null || snapshot === null) throw new Error('expected geometry markers');
    marker.before(snapshot);
    page.scene.documentHtml = `<!doctype html>${parsed.documentElement.outerHTML}`;
    const prefixed = workspaceForDocument(document);
    expect(() => prefixed.workspace.inspectGeometry(prefixed.pageId)).toThrow(
      'must immediately follow',
    );

    for (const separator of [' ', '\n', '&nbsp;', '\u00a0', '\ufeff', '\u001c']) {
      const separated = documentWith(v2, true);
      const separatedPage = separated.pages[0]!;
      if (separatedPage.sceneType !== 'interactive') throw new Error('expected interactive page');
      separatedPage.scene.documentHtml = separatedPage.scene.documentHtml.replace(
        '<script type="application/json" data-reach-geometry-snapshot',
        `${separator}<script type="application/json" data-reach-geometry-snapshot`,
      );
      const workspace = workspaceForDocument(separated);
      expect(() => workspace.workspace.inspectGeometry(workspace.pageId)).toThrow(
        'must immediately follow',
      );
    }
  });

  it('requires authoring bindings before accepting an authored snapshot', () => {
    const withoutBindings = structuredClone(v2) as any;
    delete withoutBindings.spec.authoring;
    const document = documentWith(withoutBindings);
    const page = document.pages[0]!;
    if (page.sceneType !== 'interactive') throw new Error('expected interactive page');
    page.scene.documentHtml = html(withoutBindings).replace(
      '<script>const R=',
      `<script type="application/json" data-reach-geometry-snapshot="geometry">${JSON.stringify(authoredSnapshot(v2))}</script><script>const R=`,
    );
    expect(() =>
      workspaceFor(withoutBindings).workspace.inspectGeometry(page.pageId),
    ).not.toThrow();
    const session = new DecksmithDocumentSession(document, 'reach-deck-decksmith/v2', {
      interactiveValidationOptions: {
        scientificCapabilityPolicy: 'normal',
        allowedRuntimeDependencies: [{ id: 'geometry-euclidean-2d-v2', version: '1.0.0' }],
      },
    });
    expect(() => new DecksmithInteractiveWorkspace(session).inspectGeometry(page.pageId)).toThrow(
      'snapshot requires authoring bindings',
    );
  });

  it('rejects binding widening, protected deletion, and unbound presentation edits', async () => {
    const attempts = [
      (envelope: any) => {
        envelope.spec.authoring!.externalReferences = [];
      },
      (envelope: any) => {
        envelope.spec.presentation.objects = envelope.spec.presentation.objects.map((entry: any) =>
          entry.object === 'A' ? { ...entry, label: 'unbound' } : entry,
        );
      },
      (envelope: any) => {
        envelope.spec.authoring!.editable.objects.push('A');
      },
    ];
    for (const mutate of attempts) {
      const { pageId, workspace } = workspaceFor(v2);
      const inspection = workspace.inspectGeometry(pageId);
      const envelope = structuredClone(v2) as any;
      mutate(envelope);
      await expect(
        workspace.proposeGeometryEdit({
          pageId,
          instanceId: 'geometry',
          expectedHtmlSha256: inspection.htmlSha256,
          envelope,
        }),
      ).rejects.toThrow(/GEOMETRY_EDIT_(READ_ONLY|BINDING)/);
    }
  });
});
