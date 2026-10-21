import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { InteractiveScene } from '@reachany/reach-deck-dsl';
import {
  createGeneratedInteractiveSceneParser,
  inferInteractiveRuntimeDependencies,
  GeometryGenerationSemanticError,
} from '../../lib/reach-deck/interactive-generation-validation.js';
import { isGeometryRuntime } from '../../lib/reach-deck/geometry-generation-markers.js';
import { SCIENTIFIC_GEOMETRY_EXAMPLES } from '../../lib/reach-deck/scientific-generation-examples.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const planar = () => structuredClone(fixtures[0].envelope);
const planarV2 = () =>
  structuredClone(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).envelope,
  );
const candidate = { scientificCapabilityPolicy: 'candidate' as const };
const marker = (value: unknown, id = 'main') =>
  `<div data-reach-science-kit-target="${id}"></div><script type="application/json" data-reach-science-kit="${id}">${JSON.stringify(value)}</script>`;
const scene = (body: string): InteractiveScene => ({
  schemaVersion: 'reach-interactive-scene/v2',
  id: 'geometry-test',
  title: 'Geometry',
  sceneType: 'interactive',
  bridgeVersion: 'reach-interactive-bridge/v1',
  documentHtml: `<!doctype html><html><head><style>body{margin:0}</style></head><body>${body}<script>window.ReachInteractive.ready();</script></body></html>`,
  runtimeDependencies: [{ id: 'geometry-euclidean-2d', version: '1.0.0' }],
  runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
  eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
  narration: { schemaVersion: 'reach-interactive-narration/v1', text: 'Explore the construction.' },
});
const parser = () => createGeneratedInteractiveSceneParser('geometry-test', candidate);
const sceneV2 = (body: string): InteractiveScene => ({
  ...scene(body),
  runtimeDependencies: [{ id: 'geometry-euclidean-2d-v2', version: '1.0.0' }],
});
const invalid = () => {
  const value = planar();
  value.spec.objects.find((object: { id: string }) => object.id === 'M').a = 'missing';
  return value;
};

describe('geometry generation validation', () => {
  it('validates new v2 markers with the exact v2 runtime while retaining v1 readers', () => {
    const v2 = sceneV2(marker(planarV2()));
    expect(parser()(v2)).toEqual(v2);
    expect(inferInteractiveRuntimeDependencies(v2.documentHtml, candidate)).toEqual(
      v2.runtimeDependencies,
    );
    expect(isGeometryRuntime('geometry-euclidean-2d')).toBe(true);
    expect(isGeometryRuntime('geometry-euclidean-2d-v2')).toBe(true);
    expect(() =>
      createGeneratedInteractiveSceneParser(v2.id, {
        ...candidate,
        allowedRuntimeDependencies: [{ id: 'geometry-euclidean-2d', version: '1.0.0' }],
      })(v2),
    ).toThrow(/runtime is not authorized/);
    expect(parser()(scene(marker(planar())))).toEqual(scene(marker(planar())));
  });

  it('requires authoring bindings only for fresh v2 geometry generation', () => {
    const unbound = planarV2();
    delete unbound.spec.authoring;
    const unboundScene = sceneV2(marker(unbound));

    expect(parser()(unboundScene)).toEqual(unboundScene);
    const freshParser = createGeneratedInteractiveSceneParser('geometry-test', {
      ...candidate,
      requireGeometryAuthoring: true,
    });
    let failure: unknown;
    try {
      freshParser(unboundScene);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'structure-invalid' });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      'requires valid reach-geometry-authoring/v1 bindings',
    );
    expect(freshParser(sceneV2(marker(planarV2())))).toEqual(sceneV2(marker(planarV2())));

    const legacyScene = scene(marker(planar()));
    expect(parser()(legacyScene)).toEqual(legacyScene);
    const freshV2OnlyParser = createGeneratedInteractiveSceneParser('geometry-test', {
      ...candidate,
      requireGeometryAuthoring: true,
      allowedRuntimeDependencies: [{ id: 'geometry-euclidean-2d-v2', version: '1.0.0' }],
    });
    expect(() => freshV2OnlyParser(legacyScene)).toThrow(
      /fresh geometry generation requires kitVersion:2/,
    );
    expect(freshV2OnlyParser(sceneV2(marker(planarV2())))).toEqual(sceneV2(marker(planarV2())));
  });

  it('does not count the separate authored snapshot as a science-kit marker', () => {
    const withSnapshot = sceneV2(
      `${marker(planarV2())}<script type="application/json" data-reach-geometry-snapshot="main">{}</script>`,
    );
    expect(inferInteractiveRuntimeDependencies(withSnapshot.documentHtml, candidate)).toEqual([
      { id: 'geometry-euclidean-2d-v2', version: '1.0.0' },
    ]);
  });

  it('evaluates both 2D and 3D v2 exploration fixtures and reports their contract version', () => {
    const spatial = SCIENTIFIC_GEOMETRY_EXAMPLES.find((example) => example.dimension === 3)!;
    const spatialScene = {
      ...scene(marker(spatial.envelope)),
      runtimeDependencies: [{ id: 'geometry-euclidean-3d-v2', version: '1.0.0' }],
    } as InteractiveScene;
    expect(parser()(sceneV2(marker(planarV2()))).runtimeDependencies).toEqual([
      { id: 'geometry-euclidean-2d-v2', version: '1.0.0' },
    ]);
    expect(parser()(spatialScene)).toEqual(spatialScene);

    const invalidV2 = planarV2();
    invalidV2.spec.objects.find((object: { id: string }) => object.id === 'AP').a = 'missing';
    expect(() => parser()(sceneV2(marker(invalidV2)))).toThrow(/Geometry marker main \[v2\]/);
  });

  it('uses trusted task diagnostics within the same per-instance correction locks', () => {
    const wrong = planar();
    wrong.spec.objects.find((object: { id: string }) => object.id === 'B').x = 6;
    const parse = createGeneratedInteractiveSceneParser('geometry-test', {
      ...candidate,
      validateScene: (value) => {
        if (value.documentHtml.includes(JSON.stringify(wrong))) {
          throw new GeometryGenerationSemanticError('Geometry marker main: B must start at x=4', [
            'main',
          ]);
        }
      },
    });
    expect(() => parse(scene(marker(wrong)))).toThrow(/B must start/);
    expect(parse(scene(marker(planar()))).id).toBe('geometry-test');
  });
  it('supports normal geometry generation and enforces selected runtime pins', () => {
    const value = scene(marker(planar()));
    expect(createGeneratedInteractiveSceneParser(value.id)(value)).toEqual(value);
    expect(parser()(value)).toEqual(value);
    expect(() =>
      createGeneratedInteractiveSceneParser(value.id, {
        ...candidate,
        allowedRuntimeDependencies: [],
      })(value),
    ).toThrow(/authorized/);
    expect(inferInteractiveRuntimeDependencies(value.documentHtml, candidate)).toEqual(
      value.runtimeDependencies,
    );
  });

  it('rejects initial degeneration and false assertions with instance/object diagnostics', () => {
    const value = planar();
    value.spec.objects.find((object: { id: string }) => object.id === 'B').x = 0;
    expect(() => parser()(scene(marker(value)))).toThrow(
      /Geometry marker main \[v1\]:.*(AB|Perpendicular)/,
    );
    const wrongAssertion = planar();
    wrongAssertion.spec.assertions.push({ id: 'wrong', kind: 'onLine', point: 'Q', line: 'AB' });
    expect(() => parser()(scene(marker(wrongAssertion)))).toThrow(/wrong/);
  });

  it('captures locks on the rejected original and accepts only its corrected marker', () => {
    const parse = parser();
    expect(() => parse(scene(marker(invalid())))).toThrow(/Geometry marker main/);
    expect(parse(scene(marker(planar())))).toEqual(scene(marker(planar())));
  });

  it('captures the original even when a declared geometry marker contains malformed JSON', () => {
    const parse = parser();
    const original = scene(marker(planar()));
    original.documentHtml = original.documentHtml.replace(JSON.stringify(planar()), '{invalid');
    expect(() => parse(original)).toThrow(/Geometry marker main: invalid JSON/);
    const repaired = scene(marker(planar()));
    repaired.title = 'Collateral rewrite';
    expect(() => parse(repaired)).toThrow(/protected fields/);
    expect(parse(scene(marker(planar()))).title).toBe('Geometry');
  });

  it('does not grant a fresh repair baseline after hard marker failures', () => {
    const parse = parser();
    const original = scene(marker(planar()));
    original.documentHtml = original.documentHtml.replace(
      '<div data-reach-science-kit-target="main"></div>',
      '',
    );
    expect(() => parse(original)).toThrow(/exactly one target/);
    const rewritten = scene(marker(planar()));
    rewritten.title = 'Unrelated replacement';
    expect(() => parse(rewritten)).toThrow(/protected fields/);
  });

  it.each(['legacy', 'candidate'] as const)(
    'locks undeclared malformed markers under %s policy',
    (policy) => {
      const parse = createGeneratedInteractiveSceneParser('geometry-test', {
        scientificCapabilityPolicy: policy,
      });
      const original = scene(marker(planar()));
      original.runtimeDependencies = [];
      original.documentHtml = original.documentHtml.replace(JSON.stringify(planar()), '{invalid');
      expect(() => parse(original)).toThrow(/valid JSON/);
      const replacement = scene('A replacement page');
      replacement.runtimeDependencies = [];
      replacement.title = 'Replacement';
      expect(() => parse(replacement)).toThrow(/protected fields/);
    },
  );

  it.each(['title', 'narration', 'script', 'css', 'other-instance', 'marker-id'])(
    'rejects collateral %s changes during geometry correction',
    (change) => {
      const parse = parser();
      expect(() => parse(scene(marker(invalid()) + marker(planar(), 'other')))).toThrow(
        /Geometry marker main/,
      );
      const corrected = scene(marker(planar()) + marker(planar(), 'other'));
      if (change === 'title') corrected.title = 'Changed';
      if (change === 'narration') corrected.narration!.text = 'Changed';
      if (change === 'script')
        corrected.documentHtml = corrected.documentHtml.replace('ready()', 'reset()');
      if (change === 'css')
        corrected.documentHtml = corrected.documentHtml.replace('margin:0', 'margin:1px');
      if (change === 'marker-id')
        corrected.documentHtml = corrected.documentHtml.replaceAll('"main"', '"renamed"');
      if (change === 'other-instance') {
        const changed = planar();
        changed.spec.ariaLabel = 'Changed';
        corrected.documentHtml = scene(marker(planar()) + marker(changed, 'other')).documentHtml;
      }
      expect(() => parse(corrected)).toThrow(/protected fields/);
    },
  );

  it('allows necessary geometry dependency correction and rejects unrelated additions', () => {
    const parse = parser();
    const original = { ...scene(marker(invalid())), runtimeDependencies: [] };
    expect(() => parse(original)).toThrow(/Geometry marker main/);
    expect(parse(scene(marker(planar()))).runtimeDependencies).toHaveLength(1);
    const parseOther = parser();
    expect(() => parseOther(original)).toThrow(/Geometry marker main/);
    const repaired = scene(marker(planar()));
    repaired.runtimeDependencies!.push({ id: 'expression', version: '3.0.3' });
    expect(() => parseOther(repaired)).toThrow(/protected fields/);
  });

  it('retains exact dependency locks for pure JavaScript corrections', () => {
    const parse = parser();
    const original = scene(marker(planar()));
    original.documentHtml = original.documentHtml.replace(
      'window.ReachInteractive.ready();',
      'const broken = ;',
    );
    expect(() => parse(original)).toThrow(/invalid JavaScript/);
    const repaired = scene(marker(planar()));
    repaired.runtimeDependencies = [];
    expect(() => parse(repaired)).toThrow(/protected fields.*runtimeDependencies/);
  });

  it('validates every marker target and applies mixed-page budgets', () => {
    const html = scene(marker(planar())).documentHtml;
    expect(() =>
      inferInteractiveRuntimeDependencies(
        html.replace('<div data-reach-science-kit-target="main"></div>', ''),
        candidate,
      ),
    ).toThrow(/exactly one target/);
    expect(() => parser()(scene(marker(planar()) + marker(planar())))).toThrow(
      /duplicated|exactly one target/,
    );
    expect(() =>
      parser()(
        scene(Array.from({ length: 5 }, (_, index) => marker(planar(), `kit${index}`)).join('')),
      ),
    ).toThrow(/page_markers/);
    const spatial = fixtures.find(
      (fixture: { envelope: { kitId: string }; expected: { accepted: boolean } }) =>
        fixture.envelope.kitId === 'euclidean-geometry-3d' && fixture.expected.accepted,
    ).envelope;
    const heavy = scene(marker(spatial) + marker(spatial, 'second'));
    heavy.runtimeDependencies = [{ id: 'geometry-euclidean-3d', version: '1.0.0' }];
    expect(() => parser()(heavy)).toThrow(/page_heavy/);
  });

  it('does not execute model code during parsing or geometry evaluation', () => {
    const value = scene(marker(planar()));
    value.documentHtml = value.documentHtml.replace(
      'window.ReachInteractive.ready();',
      'globalThis.geometryGenerationExecuted = true;',
    );
    parser()(value);
    expect(
      (globalThis as { geometryGenerationExecuted?: boolean }).geometryGenerationExecuted,
    ).toBeUndefined();
  });

  it('rejects eager candidate initialization that can consume the restore guard', () => {
    const value = scene(marker(planar()));
    value.documentHtml = value.documentHtml.replace(
      'window.ReachInteractive.ready();',
      'function initialize(detail){window.ReachInteractive.ready({restored:false});} window.addEventListener("reach-interactive-initialize", event => initialize(event.detail)); initialize(window.ReachInteractive.getInitialization());',
    );
    expect(() => parser()(value)).toThrow(/must initialize from reach-interactive-initialize/);
    expect(() =>
      createGeneratedInteractiveSceneParser(value.id, { scientificCapabilityPolicy: 'legacy' })(
        value,
      ),
    ).not.toThrow(/must initialize/);
  });

  it('allows the correction to remove eager candidate initialization without changing the page', () => {
    const parse = parser();
    const eager = scene(marker(planar()));
    eager.documentHtml = eager.documentHtml.replace(
      'window.ReachInteractive.ready();',
      'function initialize(detail){window.ReachInteractive.ready({restored:false});} window.addEventListener("reach-interactive-initialize", event => initialize(event.detail)); initialize(window.ReachInteractive.getInitialization());',
    );
    expect(() => parse(eager)).toThrow(/must initialize from reach-interactive-initialize/);

    const corrected = structuredClone(eager);
    corrected.documentHtml = corrected.documentHtml.replace(
      ' initialize(window.ReachInteractive.getInitialization());',
      '',
    );
    expect(parse(corrected)).toEqual(corrected);
  });
});
