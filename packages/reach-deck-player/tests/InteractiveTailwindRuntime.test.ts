import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { buildInteractiveSrcDoc } from '../src/interactiveBridge.js';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '../src/interactiveExternalRuntimes.generated.js';

const eventManifest = {
  schemaVersion: 'reach-interactive-event-manifest/v1',
  events: [],
};
const dependency = [{ id: 'tailwind-browser' as const, version: '4.3.0' as const }];
const build = (documentHtml: string, runtimeDependencies = dependency) =>
  buildInteractiveSrcDoc({
    documentHtml,
    nonce: '1234567890abcdef',
    allowReset: false,
    eventManifest,
    runtimeDependencies,
    dependencyBaseUrl: 'https://student.example/path',
  });

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

describe('Interactive Tailwind browser runtime', () => {
  it('injects the exact content-addressed document runtime with SRI and a bounded CSP', () => {
    const source = build(
      '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><head></head><body><main class="grid md:grid-cols-2"></main></body></html>',
    );
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      ({ id }) => id === 'tailwind-browser',
    );

    expect(entry?.category).toBe('document');
    expect(source).toContain(`src="https://student.example${entry?.scriptPath}"`);
    expect(source).toContain(`integrity="${entry?.integrity}"`);
    expect(source).toContain('crossorigin="anonymous"');
    expect(source).toContain('referrerpolicy="no-referrer"');
    expect(source).toContain(
      `script-src 'unsafe-inline' https://student.example${entry?.scriptPath}`,
    );
    expect(source).toContain('data-reach-interactive-runtime="tailwind-browser@4.3.0"');
    expect(source).not.toContain('@tailwindcss/browser');
  });

  it('loads and executes the content-addressed runtime in Chromium, including dynamic classes', async () => {
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      ({ id }) => id === 'tailwind-browser',
    );
    if (entry === undefined) throw new Error('Tailwind browser runtime is not registered.');
    const runtimeSource = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../apps/student/public',
        entry.scriptPath.slice(1),
      ),
    );
    const runtimeRequests: string[] = [];
    const runtimeRequestOrigins: Array<string | undefined> = [];
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
        runtimeRequests.push(request.url);
        runtimeRequestOrigins.push(request.headers.origin);
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
      throw new Error('Tailwind browser test server did not bind a TCP port.');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    source = buildInteractiveSrcDoc({
      documentHtml:
        '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><head></head><body><main id="probe" class="grid md:grid-cols-2 w-[123px] bg-white/80 shadow-lg"><div>one</div><div>two</div></main></body></html>',
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
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(origin, { waitUntil: 'load' });
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      if (frame === undefined) throw new Error('Sandboxed runtime iframe did not load.');
      await frame.waitForFunction(() => {
        const element = document.querySelector('#probe');
        return element !== null && getComputedStyle(element).width === '123px';
      });

      const probe = frame.locator('#probe');
      const initial = await probe.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          boxShadow: style.boxShadow,
          display: style.display,
          gridTemplateColumns: style.gridTemplateColumns,
          width: style.width,
        };
      });
      expect(initial.display).toBe('grid');
      expect(initial.gridTemplateColumns.split(' ')).toHaveLength(2);
      expect(initial.width).toBe('123px');
      expect(initial.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(initial.backgroundColor).not.toBe('transparent');
      expect(initial.boxShadow).not.toBe('none');

      await probe.evaluate((element) => element.classList.add('mt-[37px]'));
      await frame.waitForFunction(() => {
        const element = document.querySelector('#probe');
        return element !== null && getComputedStyle(element).marginTop === '37px';
      });
      expect(runtimeRequests).toEqual([entry.scriptPath]);
      expect(runtimeRequestOrigins).toEqual(['null']);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }, 30_000);

  it('blocks tampered runtime bytes by SRI inside the opaque sandbox iframe', async () => {
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      ({ id }) => id === 'tailwind-browser',
    );
    if (entry === undefined) throw new Error('Tailwind browser runtime is not registered.');
    const runtimeSource = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../apps/student/public',
        entry.scriptPath.slice(1),
      ),
    );
    const requestOrigins: Array<string | undefined> = [];
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
        requestOrigins.push(request.headers.origin);
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'content-type': 'text/javascript; charset=utf-8',
        });
        response.end(Buffer.concat([runtimeSource, Buffer.from('\n/* tampered */')]));
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
      throw new Error('Tailwind browser test server did not bind a TCP port.');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    source = buildInteractiveSrcDoc({
      documentHtml:
        '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><head></head><body><main id="probe" class="w-[123px]">probe</main></body></html>',
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
      await page.goto(origin, { waitUntil: 'load' });
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      if (frame === undefined) throw new Error('Sandboxed runtime iframe did not load.');
      const probe = frame.locator('#probe');
      await expect.poll(() => requestOrigins.length).toBe(1);
      await page.waitForTimeout(500);
      expect(await probe.evaluate((element) => getComputedStyle(element).width)).not.toBe('123px');
      expect(requestOrigins).toEqual(['null']);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }, 30_000);

  it.each([
    {
      name: 'missing root marker',
      html: '<!doctype html><html><head></head><body></body></html>',
      dependencies: dependency,
    },
    {
      name: 'marker without dependency',
      html: '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><head></head><body></body></html>',
      dependencies: [],
    },
    {
      name: 'wrong marker version',
      html: '<!doctype html><html data-reach-tailwind-runtime="4.2.0"><head></head><body></body></html>',
      dependencies: dependency,
    },
    {
      name: 'marker on body',
      html: '<!doctype html><html><head></head><body data-reach-tailwind-runtime="4.3.0"></body></html>',
      dependencies: dependency,
    },
    {
      name: 'extra marker outside root',
      html: '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><head></head><body><main data-reach-tailwind-runtime="4.3.0"></main></body></html>',
      dependencies: dependency,
    },
  ])('rejects $name', ({ html, dependencies }) => {
    expect(() => build(html, dependencies)).toThrow(/Tailwind|tailwind-browser/);
  });
});
