import scenario from '../../reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { InteractiveRuntimeDependency } from '@reachany/reach-deck-dsl';
import type { GeometryEnvelopeV2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { createGeometrySessionV2 } from '@reachany/reach-deck-geometry/session-v2';
import {
  buildInteractiveSrcDoc,
  validateGeometryEditProposalAgainstDocument,
} from '../src/interactiveBridge.js';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '../src/interactiveExternalRuntimes.generated.js';

const fixture = scenario as unknown as { envelope: GeometryEnvelopeV2 };
const markerHtml = `<!doctype html><html><head></head><body><div data-reach-science-kit-target="geometry"></div><script type="application/json" data-reach-science-kit="geometry">${JSON.stringify(fixture.envelope)}</script></body></html>`;
const dependency: InteractiveRuntimeDependency = {
  id: 'geometry-euclidean-2d-v2',
  version: '1.0.0',
};

const source = (mode: 'learner' | 'authoring-edit' | 'authoring-trial' = 'learner') =>
  buildInteractiveSrcDoc({
    documentHtml: markerHtml,
    nonce: '0123456789abcdef',
    allowReset: true,
    eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
    runtimeDependencies: [dependency],
    dependencyBaseUrl: 'https://student.example',
    geometryHostMode: mode,
    pageId: 'page-1',
    sourceRevision: 7,
  });

const state = (value: number) => ({
  schemaVersion: 'reach-geometry-state/v2',
  instanceId: 'geometry',
  fingerprint: 'a'.repeat(64),
  value,
});

describe('geometry v2 Player bridge', () => {
  it('routes kitVersion 2 to a separate immutable runtime without changing v1 pins', () => {
    const output = source();
    const v2 = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      (entry) => entry.id === 'geometry-euclidean-2d-v2',
    )!;
    const v1 = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      (entry) => entry.id === 'geometry-euclidean-2d',
    )!;
    expect(output).toContain(v2.integrity);
    expect(output).toContain(`https://student.example${v2.scriptPath}`);
    expect(output).not.toContain(v1.integrity);
    expect(() =>
      buildInteractiveSrcDoc({
        documentHtml: markerHtml,
        nonce: '0123456789abcdef',
        allowReset: true,
        eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
        runtimeDependencies: [{ id: 'geometry-euclidean-2d', version: '1.0.0' }],
      }),
    ).toThrow(/exactly match/);
  });

  it('restores the exact v2 instance set and publishes canonical aggregate state automatically', () => {
    const dom = new JSDOM(source(), { runScripts: 'outside-only', url: 'https://student.example' });
    Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' });
    let current = state(0);
    let context: Record<string, unknown> | undefined;
    const setState = vi.fn((next: typeof current) => {
      current = next;
      return true;
    });
    const geometryStateFits = vi.fn(() => true);
    const geometryStateChange = vi.fn(() => true);
    const geometryEditProposal = vi.fn(() => true);
    Object.assign(dom.window, {
      structuredClone,
      ReachInteractive: { geometryStateFits, geometryStateChange, geometryEditProposal },
      __reachScienceKitFacades: {
        'geometry-euclidean-2d-v2': {
          mount: (_target: HTMLElement, _spec: unknown, mountContext: Record<string, unknown>) => {
            context = mountContext;
            return {
              reset: vi.fn(),
              destroy: vi.fn(),
              getState: () => current,
              setState,
            };
          },
        },
      },
    });
    dom.window.eval(
      dom.window.document.querySelector('[data-reach-science-kit-install]')!.textContent!,
    );
    const restored = state(9);
    dom.window.dispatchEvent(
      new dom.window.CustomEvent('reach-interactive-initialize', {
        detail: {
          restoredSnapshot: {
            kind: 'interactive',
            geometry: {
              schemaVersion: 'reach-geometry-host-state/v2',
              instances: { geometry: restored },
            },
          },
        },
      }),
    );
    expect(setState).toHaveBeenCalledWith(restored);
    expect(geometryStateChange).toHaveBeenLastCalledWith({ geometry: restored });
    expect(context).toMatchObject({
      geometryHostMode: 'learner',
      pageId: 'page-1',
      sourceRevision: 7,
    });
    expect((context!.canAdoptState as (value: unknown) => boolean)(state(10))).toBe(true);
    expect(geometryStateFits).toHaveBeenLastCalledWith({ geometry: state(10) });
    dom.window.close();
  });

  it('preserves compatible authoring state after the envelope fingerprint changes', () => {
    const dom = new JSDOM(source('authoring-edit'), {
      runScripts: 'outside-only',
      url: 'https://teacher.example',
    });
    Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' });
    const initial = {
      schemaVersion: 'reach-geometry-state/v2',
      instanceId: 'geometry',
      fingerprint: 'b'.repeat(64),
      inputs: { parameters: { scale: 1 }, freedoms: {} },
      auxiliary: {
        objects: [],
        measurements: [],
        relations: [],
        freedoms: [],
        presentation: { objects: [], measurements: [], relations: [] },
      },
      hiddenAuxiliary: [],
      selection: null,
      visibleGroups: [],
      camera: { kind: 'planar', bounds: [-8, -6, 8, 6] },
    };
    let current = initial;
    const setState = vi.fn((next: typeof initial) => {
      const accepted =
        next.fingerprint === initial.fingerprint && next.auxiliary.objects.length === 0;
      if (accepted) current = next;
      return accepted;
    });
    const geometryStateChange = vi.fn(() => true);
    Object.assign(dom.window, {
      structuredClone,
      ReachInteractive: {
        geometryStateFits: () => true,
        geometryStateChange,
        geometryEditProposal: () => true,
      },
      __reachScienceKitFacades: {
        'geometry-euclidean-2d-v2': {
          mount: () => ({
            reset() {},
            destroy() {},
            getState: () => current,
            setState,
          }),
        },
      },
    });
    dom.window.eval(
      dom.window.document.querySelector('[data-reach-science-kit-install]')!.textContent!,
    );
    const restored = {
      ...initial,
      fingerprint: 'a'.repeat(64),
      inputs: { parameters: { scale: 4 }, freedoms: {} },
      auxiliary: {
        ...initial.auxiliary,
        objects: [{ id: 'learner-point', kind: 'freePoint', x: 1, y: 2 }],
      },
      selection: 'learner-point',
      camera: { kind: 'planar', bounds: [-20, -10, 20, 10] },
    };
    dom.window.dispatchEvent(
      new dom.window.CustomEvent('reach-interactive-initialize', {
        detail: {
          restoredSnapshot: {
            geometry: {
              schemaVersion: 'reach-geometry-host-state/v2',
              instances: { geometry: restored },
            },
          },
        },
      }),
    );

    expect(setState).toHaveBeenCalledTimes(3);
    expect(setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fingerprint: initial.fingerprint,
        inputs: { parameters: { scale: 4 }, freedoms: {} },
        auxiliary: initial.auxiliary,
        selection: null,
        camera: restored.camera,
      }),
    );
    expect(geometryStateChange).toHaveBeenLastCalledWith({ geometry: current });
    dom.window.close();
  });

  it('rejects restored authoring state when the geometry controller did not mount', () => {
    const dom = new JSDOM(source('authoring-edit'), {
      runScripts: 'outside-only',
      url: 'https://teacher.example',
    });
    Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' });
    const geometryStateChange = vi.fn(() => true);
    Object.assign(dom.window, {
      structuredClone,
      ReachInteractive: {
        geometryStateFits: () => true,
        geometryStateChange,
        geometryEditProposal: () => true,
      },
      __reachScienceKitFacades: {
        'geometry-euclidean-2d-v2': { mount: () => undefined },
      },
    });
    dom.window.eval(
      dom.window.document.querySelector('[data-reach-science-kit-install]')!.textContent!,
    );

    expect(() =>
      dom.window.dispatchEvent(
        new dom.window.CustomEvent('reach-interactive-initialize', {
          detail: {
            restoredSnapshot: {
              geometry: {
                schemaVersion: 'reach-geometry-host-state/v2',
                instances: { geometry: { fingerprint: 'a'.repeat(64) } },
              },
            },
          },
        }),
      ),
    ).not.toThrow();
    expect(geometryStateChange).not.toHaveBeenCalled();
    dom.window.close();
  });

  it('emits validated edit proposals only in authoring-edit mode', () => {
    for (const [mode, expected] of [
      ['authoring-edit', 1],
      ['authoring-trial', 0],
    ] as const) {
      const dom = new JSDOM(source(mode), {
        runScripts: 'outside-only',
        url: 'https://teacher.example',
      });
      Object.defineProperty(dom.window.document, 'readyState', { value: 'complete' });
      const current = state(4);
      let context: Record<string, unknown> | undefined;
      const geometryEditProposal = vi.fn(() => true);
      Object.assign(dom.window, {
        structuredClone,
        ReachInteractive: {
          geometryStateFits: () => true,
          geometryStateChange: () => true,
          geometryEditProposal,
        },
        __reachScienceKitFacades: {
          'geometry-euclidean-2d-v2': {
            mount: (
              _target: HTMLElement,
              _spec: unknown,
              mountContext: Record<string, unknown>,
            ) => {
              context = mountContext;
              return {
                reset() {},
                destroy() {},
                getState: () => current,
                setState: () => true,
              };
            },
          },
        },
      });
      dom.window.eval(
        dom.window.document.querySelector('[data-reach-science-kit-install]')!.textContent!,
      );
      (context!.onStateChange as () => boolean)();
      expect(geometryEditProposal).toHaveBeenCalledTimes(expected);
      if (expected)
        expect(geometryEditProposal).toHaveBeenCalledWith({
          schemaVersion: 'reach-geometry-edit-proposal/v1',
          pageId: 'page-1',
          sourceRevision: 7,
          instanceId: 'geometry',
          fingerprint: current.fingerprint,
          state: current,
        });
      dom.window.close();
    }
  });

  it('re-resolves the authored envelope and rejects stale proposal identity', () => {
    const session = createGeometrySessionV2(fixture.envelope, 'geometry');
    const fingerprint = session.getState().fingerprint;
    session.dispose();
    const payload = {
      schemaVersion: 'reach-geometry-edit-proposal/v1',
      pageId: 'page-1',
      sourceRevision: 7,
      instanceId: 'geometry',
      fingerprint,
      state: { ...state(2), fingerprint },
    };
    expect(
      validateGeometryEditProposalAgainstDocument({
        payload,
        documentHtml: markerHtml,
        pageId: 'page-1',
        sourceRevision: 7,
        wireSequence: 11,
      }),
    ).toMatchObject({
      envelope: fixture.envelope,
      pageId: 'page-1',
      sourceRevision: 7,
      instanceId: 'geometry',
      wireSequence: 11,
    });
    expect(
      validateGeometryEditProposalAgainstDocument({
        payload,
        documentHtml: markerHtml,
        pageId: 'page-1',
        sourceRevision: 8,
        wireSequence: 11,
      }),
    ).toBeUndefined();
    expect(
      validateGeometryEditProposalAgainstDocument({
        payload: {
          ...payload,
          fingerprint: 'b'.repeat(64),
          state: { ...payload.state, fingerprint: 'b'.repeat(64) },
        },
        documentHtml: markerHtml,
        pageId: 'page-1',
        sourceRevision: 7,
        wireSequence: 11,
      }),
    ).toBeUndefined();
  });

  it('strictly binds an adjacent authored snapshot to the envelope fingerprint', () => {
    const session = createGeometrySessionV2(fixture.envelope, 'geometry');
    try {
      const initial = session.getState();
      const authored = {
        schemaVersion: 'reach-geometry-authored-snapshot/v1',
        instanceId: 'geometry',
        fingerprint: initial.fingerprint,
        inputs: initial.inputs,
        camera: { kind: 'planar', bounds: [-3, -3, 9, 7] },
      };
      const snapshotScript = `<script type="application/json" data-reach-geometry-snapshot="geometry">${JSON.stringify(authored)}</script>`;
      const withSnapshot = markerHtml.replace('</body>', `${snapshotScript}</body>`);
      expect(
        buildInteractiveSrcDoc({
          documentHtml: withSnapshot,
          nonce: '0123456789abcdef',
          allowReset: true,
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          runtimeDependencies: [dependency],
        }),
      ).toContain('reach-geometry-authored-snapshot/v1');
      const stale = withSnapshot.replace(initial.fingerprint, 'b'.repeat(64));
      expect(() =>
        buildInteractiveSrcDoc({
          documentHtml: stale,
          nonce: '0123456789abcdef',
          allowReset: true,
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          runtimeDependencies: [dependency],
        }),
      ).toThrow(/snapshot marker contract/);
      const beforeGeometry = markerHtml.replace(
        '<script type="application/json" data-reach-science-kit="geometry">',
        `${snapshotScript}<script type="application/json" data-reach-science-kit="geometry">`,
      );
      expect(() =>
        buildInteractiveSrcDoc({
          documentHtml: beforeGeometry,
          nonce: '0123456789abcdef',
          allowReset: true,
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          runtimeDependencies: [dependency],
        }),
      ).toThrow(/must immediately follow/);
      const commented = withSnapshot.replace(snapshotScript, `<!-- separator -->${snapshotScript}`);
      expect(() =>
        buildInteractiveSrcDoc({
          documentHtml: commented,
          nonce: '0123456789abcdef',
          allowReset: true,
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          runtimeDependencies: [dependency],
        }),
      ).toThrow(/must immediately follow/);
      for (const separator of [' ', '\n', '&nbsp;', '\u00a0', '\ufeff', '\u001c']) {
        const separatedByText = withSnapshot.replace(
          snapshotScript,
          `${separator}${snapshotScript}`,
        );
        expect(() =>
          buildInteractiveSrcDoc({
            documentHtml: separatedByText,
            nonce: '0123456789abcdef',
            allowReset: true,
            eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
            runtimeDependencies: [dependency],
          }),
        ).toThrow(/must immediately follow/);
      }
      const separated = withSnapshot.replace(
        '<script type="application/json" data-reach-geometry-snapshot',
        '<div></div><script type="application/json" data-reach-geometry-snapshot',
      );
      expect(() =>
        buildInteractiveSrcDoc({
          documentHtml: separated,
          nonce: '0123456789abcdef',
          allowReset: true,
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          runtimeDependencies: [dependency],
        }),
      ).toThrow(/must immediately follow/);
    } finally {
      session.dispose();
    }
  });
});
