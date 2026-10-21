import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { buildInteractiveSrcDoc } from '../src/interactiveBridge.js';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '../src/interactiveExternalRuntimes.generated.js';
import { resolveInteractiveRuntimes } from '../src/interactiveRuntimeRegistry.js';

const eventManifest = { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] };
const dependency = [{ id: 'three-module' as const, version: '0.185.1' as const }];
const markedDocument = (body: string) =>
  `<!doctype html><html data-reach-three-runtime="0.185.1"><head></head><body>${body}</body></html>`;

const iframeDocument = (srcDoc: string): string =>
  `<!doctype html><html><body><iframe id="runtime-frame" sandbox="allow-scripts" style="width:900px;height:700px;border:0" srcdoc="${srcDoc
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')}"></iframe></body></html>`;

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

describe('Interactive three module runtime', () => {
  it('injects the content-addressed runtime with SRI and a bounded CSP', () => {
    const source = buildInteractiveSrcDoc({
      documentHtml: markedDocument('<main></main>'),
      nonce: '1234567890abcdef',
      allowReset: false,
      eventManifest,
      runtimeDependencies: dependency,
      dependencyBaseUrl: 'https://student.example/path',
    });
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(({ id }) => id === 'three-module');

    expect(entry?.category).toBe('document');
    expect(source).toContain(`src="https://student.example${entry?.scriptPath}"`);
    expect(source).toContain(`integrity="${entry?.integrity}"`);
    expect(source).toContain('crossorigin="anonymous"');
    expect(source).toContain('referrerpolicy="no-referrer"');
    expect(source).toContain(
      `script-src 'unsafe-inline' https://student.example${entry?.scriptPath}`,
    );
    expect(source).toContain('data-reach-interactive-runtime="three-module@0.185.1"');
  });

  it('binds the runtime and the document root marker in both directions', () => {
    // 有标记有依赖：正常解析。
    expect(
      resolveInteractiveRuntimes({
        runtimeDependencies: [...dependency],
        hasFunctionPlotMarkers: false,
        threeRuntimeVersion: '0.185.1',
      }).map(({ id }) => id),
    ).toEqual(['three-module']);

    // 有依赖无标记：白拿 750 KiB 的 three。
    expect(() =>
      resolveInteractiveRuntimes({
        runtimeDependencies: [...dependency],
        hasFunctionPlotMarkers: false,
      }),
    ).toThrow('requires the matching document root marker');

    // 有标记无依赖：改写后的脚本会读到 undefined 全局。
    expect(() =>
      resolveInteractiveRuntimes({
        runtimeDependencies: [],
        hasFunctionPlotMarkers: false,
        threeRuntimeVersion: '0.185.1',
      }),
    ).toThrow('requires the pinned three-module runtime');

    expect(() =>
      resolveInteractiveRuntimes({ hasFunctionPlotMarkers: false, threeRuntimeVersion: '0.185.1' }),
    ).toThrow('requires the pinned three-module runtime');
  });

  it('exposes THREE and the whitelisted addons to a rewritten page script in Chromium', async () => {
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(({ id }) => id === 'three-module');
    if (entry === undefined) throw new Error('three-module runtime is not registered.');
    const runtimeSource = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../apps/student/public',
        entry.scriptPath.slice(1),
      ),
    );
    let source = '';
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(iframeDocument(source));
        return;
      }
      if (request.url === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      if (request.url === entry.scriptPath) {
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'content-type': 'text/javascript; charset=utf-8',
        });
        response.end(runtimeSource);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('three runtime test server did not bind a TCP port.');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    // 这段正是导入期改写的产物形态：没有 import，只读平台全局。
    source = buildInteractiveSrcDoc({
      documentHtml: markedDocument(
        `<div id="probe"></div><script type="module">
          const THREE = window.__reachThree;
          const { OrbitControls } = window.__reachThreeAddons;
          const scene = new THREE.Scene();
          scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial()));
          document.getElementById('probe').dataset.ready = JSON.stringify({
            revision: THREE.REVISION,
            children: scene.children.length,
            orbit: typeof OrbitControls,
          });
        </script>`,
      ),
      nonce: '1234567890abcdef',
      allowReset: false,
      eventManifest,
      runtimeDependencies: dependency,
      dependencyBaseUrl: origin,
    });

    let browser: Browser | undefined;
    try {
      browser = await launchChromium();
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(origin, { waitUntil: 'load' });
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      if (frame === undefined) throw new Error('Sandboxed runtime iframe did not load.');
      await frame.waitForFunction(
        () => document.querySelector<HTMLElement>('#probe')?.dataset.ready !== undefined,
      );
      const ready = JSON.parse(
        await frame
          .locator('#probe')
          .evaluate((element) => (element as HTMLElement).dataset.ready!),
      );

      expect(ready.children).toBe(1);
      expect(ready.orbit).toBe('function');
      expect(String(ready.revision)).toBe('185');
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
