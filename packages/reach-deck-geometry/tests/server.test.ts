import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGeometryEngine, evaluateGeometry } from '../src/index.js';
import { createGeometrySessionV2 } from '../src/sessionV2.js';

const fixtureUrl = new URL(
  '../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json',
  import.meta.url,
);
const fixtures = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {
  id: string;
  envelope: unknown;
}[];
const cases = fixtures.filter((item) => ['G1-planar-dependencies', 'G3-pyramid'].includes(item.id));
const fixtureV2Url = new URL(
  '../../reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json',
  import.meta.url,
);

describe('bundled geometry server entry', () => {
  it.each([false, true])('evaluates planar and spatial geometry in real Node (tsx=%s)', (tsx) => {
    const script = `
      import { readFileSync } from 'node:fs';
      import { createGeometryEngine, createGeometrySessionV2, evaluateGeometry } from '@reachany/reach-deck-geometry/server';
      const fixtures = JSON.parse(readFileSync(new URL(${JSON.stringify(fixtureUrl.href)}), 'utf8'));
      const fixtureV2 = JSON.parse(readFileSync(new URL(${JSON.stringify(fixtureV2Url.href)}), 'utf8'));
      const cases = fixtures.filter(item => ['G1-planar-dependencies', 'G3-pyramid'].includes(item.id));
      const engine = createGeometryEngine(cases.find(item => item.id === 'G3-pyramid').envelope);
      const session = createGeometrySessionV2(fixtureV2.envelope, 'server-v2');
      try {
        console.log(JSON.stringify({
          results: cases.map(item => evaluateGeometry(item.envelope)),
          changed: engine.applyInputs({ parameters: { h: 7, t: 0.75 } }),
          reset: engine.reset(),
          v2: session.getComputedState()
        }));
      } finally { engine.dispose(); session.dispose(); }
    `;
    const output = execFileSync(
      process.execPath,
      [...(tsx ? ['--import', 'tsx'] : []), '--input-type=module', '-e', script],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    );
    const actual = JSON.parse(output);
    expect(cases).toHaveLength(2);
    const engine = createGeometryEngine(cases.find((item) => item.id === 'G3-pyramid')!.envelope);
    try {
      const expected = {
        results: cases.map((item) => evaluateGeometry(item.envelope)),
        changed: engine.applyInputs({ parameters: { h: 7, t: 0.75 } }),
        reset: engine.reset(),
        v2: undefined as unknown,
      };
      const fixtureV2 = JSON.parse(readFileSync(fixtureV2Url, 'utf8')) as { envelope: unknown };
      const session = createGeometrySessionV2(fixtureV2.envelope, 'server-v2');
      try {
        expected.v2 = session.getComputedState();
      } finally {
        session.dispose();
      }
      expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(actual.results.every((result: { valid: boolean }) => result.valid)).toBe(true);
    } finally {
      engine.dispose();
    }
  });
});
