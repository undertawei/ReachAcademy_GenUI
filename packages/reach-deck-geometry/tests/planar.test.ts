import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeometryEnvelope } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { evaluateGeometry, type GeometryInputPatch, type GeometrySnapshot } from '../src/index.js';
import type { GeometryPlanarHit, GeometryPlanarView } from '../src/planar.js';

type Pair = readonly [number, number];
interface Harness {
  mount(envelope: GeometryEnvelope): GeometrySnapshot;
  snapshot(): GeometrySnapshot;
  apply(patch: GeometryInputPatch): GeometrySnapshot;
  paint(patch: Partial<GeometryPlanarView>): GeometrySnapshot;
  project(point: Pair): Pair | null;
  unproject(point: Pair): Pair | null;
  pick(point: Pair, device?: 'mouse' | 'touch'): GeometryPlanarHit | null;
  resize(width: number, height: number): void;
  dispose(): void;
  count(): number;
}
type TestGlobal = typeof globalThis & { geometryTest: Harness };
const fixtures = JSON.parse(
  readFileSync(
    new URL('../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json', import.meta.url),
    'utf8',
  ),
) as { id: string; envelope: GeometryEnvelope }[];
const fixture = (id = 'all-planar-operators'): GeometryEnvelope =>
  structuredClone(fixtures.find((entry) => entry.id === id)!.envelope);
let browser: Browser;
let bundle: string;
const launchChromium = async (): Promise<Browser> => {
  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    try {
      return await chromium.launch({ channel: 'chrome', headless: true });
    } catch (systemError) {
      throw new Error(
        `Unable to launch bundled Chromium or system Chrome. Bundled: ${String(bundledError)} System: ${String(systemError)}`,
      );
    }
  }
};
async function pageFor(envelope = fixture()): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  await page.setContent(
    '<!doctype html><html><body style="margin:0"><div id="board" style="width:800px;height:500px;position:relative"></div></body></html>',
  );
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    (envelope) => (globalThis as TestGlobal).geometryTest.mount(envelope),
    envelope,
  );
  return page;
}

beforeAll(async () => {
  const output = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      contents: `import {createGeometryEngine} from '../src/index.ts';
import {nativeBoardCount} from '../src/native.ts';
let engine,view;
globalThis.geometryTest={
mount(envelope){engine?.dispose();view={camera:envelope.spec.presentation.camera,selection:null,visibleGroups:envelope.spec.interaction.visibleGroups};engine=createGeometryEngine(envelope,{planar:{container:document.querySelector('#board')}});return engine.snapshot();},
snapshot(){return engine.snapshot();},
apply(patch){const result=engine.applyInputs(patch);engine.planarPresentation.paint(view);return result;},
paint(patch){const next={...view,...patch};engine.planarPresentation.paint(next);view=next;return engine.snapshot();},
project(p){return engine.planarPresentation.project(p);},unproject(p){return engine.planarPresentation.unproject(p);},pick(p,device='mouse'){return engine.planarPresentation.pick(p,device);},
resize(w,h){const target=document.querySelector('#board');target.style.width=w+'px';target.style.height=h+'px';engine.planarPresentation.resize(w,h);},
dispose(){engine.dispose();},count(){return nativeBoardCount();}
};`,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    plugins: [
      {
        name: 'private-jsxgraph-test-entry',
        setup(build) {
          build.onLoad({ filter: /jsxgraph[/\\]src[/\\]index\.js$/ }, async (args) => {
            const source = await readFile(args.path, 'utf8');
            if (!source.includes('window.JXG = JXG;') || !source.includes('self.JXG = JXG;'))
              throw new Error('jsxgraph_global_export_drift');
            return {
              contents: source.replace('window.JXG = JXG;', '').replace('self.JXG = JXG;', ''),
              loader: 'js',
            };
          });
        },
      },
    ],
  });
  bundle = output.outputFiles[0].text;
  browser = await launchChromium();
}, 20000);
afterAll(async () => {
  await browser?.close();
});

describe('same-board native SVG presentation', () => {
  it('matches NoRenderer mathematics and renders points, circles, lines and polygons', async () => {
    const envelope = fixture();
    const page = await pageFor(envelope);
    try {
      const snapshot = await page.evaluate(() =>
        (globalThis as TestGlobal).geometryTest.snapshot(),
      );
      expect(snapshot).toEqual(evaluateGeometry(envelope).snapshot);
      expect(await page.locator('#board > svg').count()).toBe(2);
      for (const id of ['A', 'AB', 'Circle', 'Triangle', 'Intersection', 'ScaleQ']) {
        const node = page.locator(`[data-reach-geometry-object="${id}"]`);
        expect(await node.evaluate((element) => getComputedStyle(element).display), id).not.toBe(
          'none',
        );
        const box = await node.boundingBox();
        expect(box && box.width + box.height, id).toBeGreaterThan(0);
      }
      expect(await page.evaluate(() => 'JXG' in globalThis || 'THREE' in globalThis)).toBe(false);
      const screenshot = await page.screenshot({ clip: { x: 0, y: 0, width: 800, height: 500 } });
      const paintedPixels = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 500;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let index = 0; index < pixels.length; index += 4)
          if (Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 240) painted++;
        return painted;
      }, screenshot.toString('base64'));
      expect(paintedPixels).toBeGreaterThan(200);
    } finally {
      await page.close();
    }
  }, 20_000);
  it('uses native projection in CSS pixels and preserves numerical revision across view changes', async () => {
    const page = await pageFor();
    try {
      const result = await page.evaluate(() => {
        const api = (globalThis as TestGlobal).geometryTest;
        const before = api.snapshot();
        const projected = api.project([2, 3])!;
        const roundTrip = api.unproject(projected);
        api.resize(390, 300);
        api.paint({ camera: { kind: 'planar', bounds: [-4, -3, 12, 9] } });
        return {
          before,
          after: api.snapshot(),
          roundTrip,
          projected,
          afterProject: api.project([2, 3]),
        };
      });
      expect(result.roundTrip![0]).toBeCloseTo(2, 10);
      expect(result.roundTrip![1]).toBeCloseTo(3, 10);
      expect(result.before).toEqual(result.after);
      expect(result.afterProject).not.toEqual(result.projected);
    } finally {
      await page.close();
    }
  });
  it('returns copied picking identities and distinguishes freedom/selection from decorative hits', async () => {
    const page = await pageFor(fixture('G1-planar-dependencies'));
    try {
      const result = await page.evaluate(() => {
        const api = (globalThis as TestGlobal).geometryTest;
        return {
          free: api.pick(api.project([4, 0])!),
          line: api.pick(api.project([3.5, 0])!),
          outside: api.pick([-10, -10]),
          auxiliary: api.pick(api.project([4, 2])!),
          frozen: Object.isFrozen(api.pick(api.project([4, 0])!)),
        };
      });
      expect(result.free).toEqual({ objectId: 'B', freedomId: 'dragB', selectable: true });
      expect(result.line).toMatchObject({ objectId: 'AB', selectable: true });
      expect(result.outside).toBeNull();
      expect(result.auxiliary).toBeNull();
      expect(result.frozen).toBe(true);
      const before = await page.evaluate(() => (globalThis as TestGlobal).geometryTest.snapshot());
      const point = await page.evaluate(() =>
        (globalThis as TestGlobal).geometryTest.project([4, 0]),
      );
      await page.mouse.move(point![0], point![1]);
      await page.mouse.down();
      await page.mouse.move(point![0] + 50, point![1] - 30);
      await page.mouse.up();
      expect(await page.evaluate(() => (globalThis as TestGlobal).geometryTest.snapshot())).toEqual(
        before,
      );
    } finally {
      await page.close();
    }
  });
  it('applies group OR visibility and explicit hidden overrides to native drawing and picking', async () => {
    const source = fixture('G1-planar-dependencies');
    const envelope = {
      ...source,
      spec: {
        ...source.spec,
        presentation: {
          ...source.spec.presentation,
          objects: [{ object: 'B', visible: false }],
          groups: [
            { id: 'g1', objects: ['Q', 'B'], measurements: [] },
            { id: 'g2', objects: ['Q'], measurements: [] },
          ],
        },
      },
    } satisfies GeometryEnvelope;
    const page = await pageFor(envelope);
    try {
      expect(await page.locator('[data-reach-geometry-object="Q"]').isVisible()).toBe(false);
      await page.evaluate(() =>
        (globalThis as TestGlobal).geometryTest.paint({ visibleGroups: ['g2'] }),
      );
      expect(await page.locator('[data-reach-geometry-object="Q"]').isVisible()).toBe(true);
      expect(await page.locator('[data-reach-geometry-object="B"]').isVisible()).toBe(false);
      const pick = await page.evaluate(() => {
        const api = (globalThis as TestGlobal).geometryTest;
        return api.pick(api.project([2, 3])!);
      });
      expect(pick).toEqual({ objectId: 'Q', freedomId: 'dragQ', selectable: true });
      await page.evaluate(() =>
        (globalThis as TestGlobal).geometryTest.paint({ visibleGroups: ['g1'] }),
      );
      expect(await page.locator('[data-reach-geometry-object="Q"]').isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('hides undefined dependencies and recovers the native geometry without stale values', async () => {
    const page = await pageFor(fixture('G1-planar-dependencies'));
    try {
      const invalid = await page.evaluate(() =>
        (globalThis as TestGlobal).geometryTest.apply({ freedoms: { dragB: { x: 0, y: 0 } } }),
      );
      expect(invalid.objects.AB.reason).toBe('zero_length_line');
      expect(await page.locator('[data-reach-geometry-object="AB"]').isVisible()).toBe(false);
      expect(await page.locator('[data-reach-geometry-object="F"]').isVisible()).toBe(false);
      const valid = await page.evaluate(() =>
        (globalThis as TestGlobal).geometryTest.apply({ freedoms: { dragB: { x: 4, y: 0 } } }),
      );
      expect(valid.objects.F.coordinates).toEqual([2, 0]);
      expect(
        await page
          .locator('[data-reach-geometry-object="AB"]')
          .evaluate((element) => getComputedStyle(element).display),
      ).not.toBe('none');
      expect(await page.locator('[data-reach-geometry-object="F"]').isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('renders labels as literal text and right-angle marks only for a valid current angle', async () => {
    const source = fixture('all-planar-operators');
    const label = '<img src=x onerror="globalThis.badLabel=true">';
    const envelope: GeometryEnvelope = {
      ...source,
      spec: {
        ...source.spec,
        presentation: {
          ...source.spec.presentation,
          objects: [
            { object: 'A', label },
            { object: 'Q', label: 'Q' },
          ],
          rightAngles: [{ id: 'square', measurement: 'lineAngleValue' }],
        },
      },
    };
    const page = await pageFor(envelope);
    try {
      expect(await page.locator('[data-reach-geometry-label="A"]').textContent()).toBe(label);
      expect(await page.locator('#board img').count()).toBe(0);
      expect(await page.evaluate(() => 'badLabel' in globalThis)).toBe(false);
      expect(await page.locator('[data-reach-geometry-right-angle="square"]').isVisible()).toBe(
        true,
      );
      await page.evaluate(() =>
        (globalThis as TestGlobal).geometryTest.apply({ freedoms: { dragB: { x: 0, y: 0 } } }),
      );
      expect(await page.locator('[data-reach-geometry-right-angle="square"]').isVisible()).toBe(
        false,
      );
    } finally {
      await page.close();
    }
  });
  it('disposes native SVG resources and rejects stale capabilities', async () => {
    const page = await pageFor();
    try {
      expect(await page.evaluate(() => (globalThis as TestGlobal).geometryTest.count())).toBe(1);
      await page.evaluate(() => {
        const api = (globalThis as TestGlobal).geometryTest;
        api.dispose();
        api.dispose();
      });
      expect(await page.locator('#board > *').count()).toBe(0);
      expect(await page.evaluate(() => (globalThis as TestGlobal).geometryTest.count())).toBe(0);
      await expect(
        page.evaluate(() => (globalThis as TestGlobal).geometryTest.project([0, 0])),
      ).rejects.toThrow('disposed');
    } finally {
      await page.close();
    }
  });
});
