import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INTERACTIVE_BRIDGE_VERSION,
  INTERACTIVE_CHANNEL,
  INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES,
  buildInteractiveSrcDoc,
  type InteractiveWireMessage,
} from '@reachany/reach-deck-player';
import { Window as HappyDomWindow } from 'happy-dom';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { createGeneratedInteractiveSceneParser } from '../../lib/reach-deck/interactive-generation-validation.js';
import {
  INTERACTIVE_TAILWIND_FIXTURE_PAGE_ID,
  INTERACTIVE_TAILWIND_FIXTURE_SCENE,
} from './fixtures/interactive-tailwind-scene.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ARTIFACT_DIRECTORY = path.join(REPOSITORY_ROOT, 'tmp/issue-461-interactive-tailwind');
const NONCE = 'issue461-tailwind-browser-nonce';
// Stable runs use at most two callbacks/RAFs for initial observation plus the induced Tailwind
// resize; allow one additional browser scheduling variation.
const MAX_BOOT_TO_CONVERGENCE_RESIZE_ACTIVITY = 3;

type SurfaceName = 'student' | 'teacher';
type ViewportName = 'desktop' | 'narrow';

interface WireMessageWithOrigin extends InteractiveWireMessage {
  readonly origin: string;
}

interface RectSnapshot {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

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

const buildSrcDocWithDom = (
  input: Parameters<typeof buildInteractiveSrcDoc>[0],
): ReturnType<typeof buildInteractiveSrcDoc> => {
  const window = new HappyDomWindow({
    settings: {
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      enableImageFileLoading: false,
      enableJavaScriptEvaluation: false,
    },
  });
  const domParserDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  const htmlScriptDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLScriptElement');
  try {
    Object.defineProperty(globalThis, 'DOMParser', {
      configurable: true,
      value: window.DOMParser,
    });
    Object.defineProperty(globalThis, 'HTMLScriptElement', {
      configurable: true,
      value: window.HTMLScriptElement,
    });
    return buildInteractiveSrcDoc(input);
  } finally {
    if (domParserDescriptor === undefined) delete (globalThis as { DOMParser?: unknown }).DOMParser;
    else Object.defineProperty(globalThis, 'DOMParser', domParserDescriptor);
    if (htmlScriptDescriptor === undefined) {
      delete (globalThis as { HTMLScriptElement?: unknown }).HTMLScriptElement;
    } else {
      Object.defineProperty(globalThis, 'HTMLScriptElement', htmlScriptDescriptor);
    }
    void window.close();
  }
};

const escapeHtmlAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

const hostDocument = (
  srcDoc: string,
  viewport: { readonly width: number; readonly height: number },
): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
    <script>
      window.__reachMessages = [];
      window.addEventListener('message', (event) => {
        const frame = document.getElementById('runtime-frame');
        const message = event.data;
        if (!frame || event.source !== frame.contentWindow || (event.origin !== 'null' && event.origin !== '')) return;
        if (!message || message.channel !== ${JSON.stringify(INTERACTIVE_CHANNEL)} || message.version !== ${JSON.stringify(INTERACTIVE_BRIDGE_VERSION)} || message.nonce !== ${JSON.stringify(NONCE)}) return;
        window.__reachMessages.push({ ...message, origin: event.origin });
        if (message.type === 'bridge_ready') {
          frame.contentWindow.postMessage({
            channel: ${JSON.stringify(INTERACTIVE_CHANNEL)},
            version: ${JSON.stringify(INTERACTIVE_BRIDGE_VERSION)},
            nonce: ${JSON.stringify(NONCE)},
            sequence: 1,
            type: 'initialize',
            payload: {
              sceneId: ${JSON.stringify(INTERACTIVE_TAILWIND_FIXTURE_PAGE_ID)},
              sourceRevision: 1,
              viewport: { width: ${viewport.width}, height: ${viewport.height}, devicePixelRatio: 1 },
              policy: ${JSON.stringify(INTERACTIVE_TAILWIND_FIXTURE_SCENE.runtimePolicy)},
              attempt: 1
            }
          }, '*');
        }
      });
    </script>
  </head>
  <body><iframe id="runtime-frame" title="Interactive Tailwind fixture" sandbox="allow-scripts" srcdoc="${escapeHtmlAttribute(srcDoc)}"></iframe></body>
</html>`;

const readMessages = (page: Page): Promise<WireMessageWithOrigin[]> =>
  page.evaluate(() =>
    (
      window as unknown as {
        __reachMessages: WireMessageWithOrigin[];
      }
    ).__reachMessages.map((message) => structuredClone(message)),
  );

const translateY = async (frame: Frame): Promise<number> =>
  frame.locator('#segment-one').evaluate((element) => {
    const translate = getComputedStyle(element).translate;
    if (translate === 'none') return 0;
    const y = translate.trim().split(/\s+/).at(-1);
    return Number.parseFloat(y ?? '0');
  });

const rectsOverlap = (left: RectSnapshot, right: RectSnapshot): boolean =>
  Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5 &&
  Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5;

const pngDimensions = (source: Buffer): { width: number; height: number } => {
  if (source.length < 24 || source.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error('Browser screenshot was not a PNG artifact.');
  }
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
};

describe('generated Interactive Tailwind browser acceptance', () => {
  it('renders the parsed scene through both checked-in role assets at desktop and narrow widths', async () => {
    const tailwindRuntime = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      ({ id }) => id === 'tailwind-browser',
    );
    if (tailwindRuntime === undefined) {
      throw new Error('The pinned Interactive Tailwind runtime is not registered.');
    }

    const runtimeRelativePath = tailwindRuntime.scriptPath.replace(/^\//, '');
    const runtimeSources = {
      student: await readFile(
        path.join(REPOSITORY_ROOT, 'apps/student/public', runtimeRelativePath),
      ),
      teacher: await readFile(
        path.join(REPOSITORY_ROOT, 'apps/teacher/public', runtimeRelativePath),
      ),
    } satisfies Record<SurfaceName, Buffer>;
    for (const source of Object.values(runtimeSources)) {
      expect(source.byteLength).toBe(tailwindRuntime.sourceBytes);
      expect(createHash('sha256').update(source).digest('hex')).toBe(tailwindRuntime.sha256);
      expect(`sha256-${createHash('sha256').update(source).digest('base64')}`).toBe(
        tailwindRuntime.integrity,
      );
    }
    expect(runtimeSources.teacher.equals(runtimeSources.student)).toBe(true);

    const parseScene = createGeneratedInteractiveSceneParser(INTERACTIVE_TAILWIND_FIXTURE_PAGE_ID);
    const parsedScene = parseScene(structuredClone(INTERACTIVE_TAILWIND_FIXTURE_SCENE));
    expect(parsedScene.runtimeDependencies).toEqual([{ id: 'tailwind-browser', version: '4.3.0' }]);
    await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
    await writeFile(
      path.join(ARTIFACT_DIRECTORY, 'parsed-scene.json'),
      `${JSON.stringify(parsedScene, null, 2)}\n`,
      'utf8',
    );

    let activeRuntimeSource: Buffer | undefined;
    let activeRender = '';
    const hostDocuments = new Map<string, string>();
    const runtimeRequests: Array<{ render: string; origin: string | undefined }> = [];
    const unknownServerRequests: string[] = [];
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const host = hostDocuments.get(requestUrl.pathname);
      if (host !== undefined) {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(host);
        return;
      }
      if (requestUrl.pathname === tailwindRuntime.scriptPath && activeRuntimeSource !== undefined) {
        runtimeRequests.push({ render: activeRender, origin: request.headers.origin });
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
          'content-type': 'text/javascript; charset=utf-8',
        });
        response.end(activeRuntimeSource);
        return;
      }
      if (requestUrl.pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      unknownServerRequests.push(requestUrl.pathname);
      response.writeHead(404).end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Interactive Tailwind fixture server did not bind a TCP port.');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    let browser: Browser | undefined;

    const layouts = new Map<
      string,
      {
        readonly columns: string;
        readonly firstSection: RectSnapshot;
        readonly secondSection: RectSnapshot;
      }
    >();

    try {
      browser = await launchChromium();
      const renderCases = [
        {
          surface: 'teacher',
          viewportName: 'desktop',
          viewport: { width: 1280, height: 800 },
          reducedMotion: 'no-preference',
        },
        {
          surface: 'teacher',
          viewportName: 'narrow',
          viewport: { width: 390, height: 844 },
          reducedMotion: 'reduce',
        },
        {
          surface: 'student',
          viewportName: 'desktop',
          viewport: { width: 1280, height: 800 },
          reducedMotion: 'no-preference',
        },
        {
          surface: 'student',
          viewportName: 'narrow',
          viewport: { width: 390, height: 844 },
          reducedMotion: 'reduce',
        },
      ] as const;

      for (const renderCase of renderCases) {
        const renderName = `${renderCase.surface}-${renderCase.viewportName}`;
        activeRuntimeSource = runtimeSources[renderCase.surface];
        activeRender = renderName;
        const srcDoc = buildSrcDocWithDom({
          documentHtml: parsedScene.documentHtml,
          nonce: NONCE,
          allowReset: parsedScene.runtimePolicy.allowReset,
          eventManifest: parsedScene.eventManifest,
          runtimeDependencies: parsedScene.runtimeDependencies,
          dependencyBaseUrl: origin,
        });
        const host = hostDocument(srcDoc, renderCase.viewport);
        const hostPath = `/render/${renderName}`;
        hostDocuments.set(hostPath, host);
        if (renderName === 'teacher-desktop') {
          await writeFile(path.join(ARTIFACT_DIRECTORY, 'host-srcdoc.html'), host, 'utf8');
        }

        const context = await browser.newContext({
          viewport: renderCase.viewport,
          reducedMotion: renderCase.reducedMotion,
        });
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const failedRequests: string[] = [];
        const failedResponses: string[] = [];
        const requestedUrls: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('request', (request) => requestedUrls.push(request.url()));
        page.on('requestfailed', (request) => failedRequests.push(request.url()));
        page.on('response', (response) => {
          if (!response.ok()) failedResponses.push(`${response.status()} ${response.url()}`);
        });
        const runtimeRequestCount = runtimeRequests.length;

        try {
          await page.goto(`${origin}${hostPath}`, { waitUntil: 'load' });
          await page.waitForFunction(() =>
            (
              window as unknown as {
                __reachMessages: Array<{ type: string }>;
              }
            ).__reachMessages.some(({ type }) => type === 'ready'),
          );
          const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
          if (frame === undefined) throw new Error(`No sandboxed frame loaded for ${renderName}.`);

          await frame.waitForFunction(() => {
            const main = document.querySelector('main');
            const container = document.querySelector<HTMLElement>('#model-container');
            const canvas = document.querySelector<HTMLCanvasElement>('#fraction-canvas');
            if (main === null || container === null || canvas === null) return false;
            const expectedSize = `${Math.round(container.clientWidth)}x${Math.round(container.clientHeight)}`;
            return (
              document.documentElement.dataset.initialized === 'true' &&
              document.documentElement.dataset.tailwindResizeTriggered === 'true' &&
              getComputedStyle(main).display === 'grid' &&
              Number(document.documentElement.dataset.resizeObserverCallbacks ?? 0) >= 1 &&
              Number(document.documentElement.dataset.resizeDraws ?? 0) >
                Number(document.documentElement.dataset.resizeBaselineDraws ?? 0) &&
              document.documentElement.dataset.initialCanvasSize !== expectedSize &&
              document.documentElement.dataset.lastCanvasSize === expectedSize &&
              canvas.width === Math.round(container.clientWidth * window.devicePixelRatio) &&
              canvas.height === Math.round(container.clientHeight * window.devicePixelRatio)
            );
          });
          await frame.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );

          const layout = await frame.evaluate(() => {
            const snapshotRect = (selector: string) => {
              const element = document.querySelector<HTMLElement>(selector);
              if (element === null) throw new Error(`Missing fixture element: ${selector}`);
              const rect = element.getBoundingClientRect();
              return {
                bottom: rect.bottom,
                height: rect.height,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                width: rect.width,
              };
            };
            const main = document.querySelector<HTMLElement>('main');
            const heading = document.querySelector<HTMLElement>('#lab-title');
            const panel = document.querySelector<HTMLElement>(
              'section[aria-label="Fraction model"]',
            );
            const container = document.querySelector<HTMLElement>('#model-container');
            const canvas = document.querySelector<HTMLCanvasElement>('#fraction-canvas');
            if (
              main === null ||
              heading === null ||
              panel === null ||
              container === null ||
              canvas === null
            ) {
              throw new Error('Fixture layout nodes are unavailable.');
            }
            const controls = ['#choice-one', '#choice-two', '#reset'].map(snapshotRect);
            const visible = [
              '#lab-title',
              '#choice-one',
              '#choice-two',
              '#reset',
              '#feedback',
              '#model-container',
            ].map(snapshotRect);
            return {
              bodyBackground: getComputedStyle(document.body).backgroundColor,
              canvas: {
                clientHeight: canvas.clientHeight,
                clientWidth: canvas.clientWidth,
                height: canvas.height,
                width: canvas.width,
              },
              containerHeight: container.getBoundingClientRect().height,
              controls,
              firstSection: snapshotRect('main > section:first-of-type'),
              headingFontSize: getComputedStyle(heading).fontSize,
              main: {
                columns: getComputedStyle(main).gridTemplateColumns,
                display: getComputedStyle(main).display,
                gap: getComputedStyle(main).gap,
                paddingLeft: getComputedStyle(main).paddingLeft,
              },
              panelShadow: getComputedStyle(panel).boxShadow,
              resize: {
                baselineCallbacks: Number(
                  document.documentElement.dataset.resizeBaselineCallbacks ?? 0,
                ),
                baselineDraws: Number(document.documentElement.dataset.resizeBaselineDraws ?? 0),
                baselineRafRequests: Number(
                  document.documentElement.dataset.resizeBaselineRafRequests ?? 0,
                ),
                callbacks: Number(document.documentElement.dataset.resizeObserverCallbacks ?? 0),
                draws: Number(document.documentElement.dataset.resizeDraws ?? 0),
                initialSize: document.documentElement.dataset.initialCanvasSize,
                rafRequests: Number(document.documentElement.dataset.resizeRafRequests ?? 0),
                size: document.documentElement.dataset.lastCanvasSize,
              },
              scroll: {
                clientHeight: document.documentElement.clientHeight,
                clientWidth: document.documentElement.clientWidth,
                scrollHeight: document.documentElement.scrollHeight,
                scrollWidth: document.documentElement.scrollWidth,
              },
              secondSection: snapshotRect('main > section:nth-of-type(2)'),
              visible,
              viewport: { height: innerHeight, width: innerWidth },
            };
          });
          await page.waitForTimeout(100);
          const convergedSize = await frame.evaluate(() => ({
            callbacks: Number(document.documentElement.dataset.resizeObserverCallbacks ?? 0),
            canvasHeight: document.querySelector<HTMLCanvasElement>('#fraction-canvas')?.height,
            canvasWidth: document.querySelector<HTMLCanvasElement>('#fraction-canvas')?.width,
            draws: Number(document.documentElement.dataset.resizeDraws ?? 0),
            rafRequests: Number(document.documentElement.dataset.resizeRafRequests ?? 0),
            size: document.documentElement.dataset.lastCanvasSize,
          }));

          expect(layout.main.display).toBe('grid');
          expect(layout.bodyBackground).toBe('rgb(248, 250, 252)');
          expect(layout.panelShadow).not.toBe('none');
          expect(layout.containerHeight).toBeCloseTo(128, 0);
          expect(layout.resize.initialSize).not.toBe(layout.resize.size);
          expect(layout.resize.initialSize?.endsWith('x108')).toBe(true);
          expect(layout.canvas.width).toBe(Math.round(layout.canvas.clientWidth));
          expect(layout.canvas.height).toBe(Math.round(layout.canvas.clientHeight));
          expect(convergedSize).toEqual({
            callbacks: expect.any(Number),
            canvasHeight: layout.canvas.height,
            canvasWidth: layout.canvas.width,
            draws: layout.resize.draws,
            rafRequests: expect.any(Number),
            size: layout.resize.size,
          });
          expect(convergedSize.callbacks - layout.resize.callbacks).toBeLessThanOrEqual(1);
          expect(convergedSize.rafRequests - layout.resize.rafRequests).toBeLessThanOrEqual(1);
          expect(convergedSize.callbacks).toBeLessThanOrEqual(
            MAX_BOOT_TO_CONVERGENCE_RESIZE_ACTIVITY,
          );
          expect(convergedSize.rafRequests).toBeLessThanOrEqual(
            MAX_BOOT_TO_CONVERGENCE_RESIZE_ACTIVITY,
          );
          expect(convergedSize.draws).toBeLessThanOrEqual(
            MAX_BOOT_TO_CONVERGENCE_RESIZE_ACTIVITY + 1,
          );
          expect(layout.resize.callbacks).toBeGreaterThanOrEqual(1);
          expect(layout.resize.rafRequests).toBeGreaterThanOrEqual(1);
          expect(layout.resize.rafRequests).toBeLessThanOrEqual(layout.resize.callbacks);
          expect(layout.resize.draws).toBeLessThanOrEqual(layout.resize.rafRequests + 1);
          expect(layout.resize.callbacks - layout.resize.baselineCallbacks).toBeGreaterThanOrEqual(
            1,
          );
          expect(layout.resize.callbacks - layout.resize.baselineCallbacks).toBeLessThanOrEqual(2);
          expect(
            layout.resize.rafRequests - layout.resize.baselineRafRequests,
          ).toBeGreaterThanOrEqual(1);
          expect(layout.resize.rafRequests - layout.resize.baselineRafRequests).toBeLessThanOrEqual(
            2,
          );
          expect(layout.resize.draws - layout.resize.baselineDraws).toBe(1);
          expect(layout.scroll.scrollWidth).toBeLessThanOrEqual(layout.scroll.clientWidth + 1);
          expect(layout.scroll.scrollHeight).toBeLessThanOrEqual(layout.scroll.clientHeight + 1);
          expect(layout.visible.every((rect) => rect.width > 0 && rect.height > 0)).toBe(true);
          expect(
            layout.visible.every(
              (rect) =>
                rect.left >= -1 &&
                rect.top >= -1 &&
                rect.right <= layout.viewport.width + 1 &&
                rect.bottom <= layout.viewport.height + 1,
            ),
          ).toBe(true);
          expect(
            layout.controls.every((rect, index) =>
              layout.controls.slice(index + 1).every((other) => !rectsOverlap(rect, other)),
            ),
          ).toBe(true);
          expect(rectsOverlap(layout.firstSection, layout.secondSection)).toBe(false);

          const isDesktop = renderCase.viewportName === 'desktop';
          expect(layout.main.columns.trim().split(/\s+/)).toHaveLength(isDesktop ? 2 : 1);
          expect(layout.main.paddingLeft).toBe(isDesktop ? '40px' : '20px');
          expect(layout.headingFontSize).toBe(isDesktop ? '48px' : '30px');
          if (isDesktop) {
            expect(layout.firstSection.right).toBeLessThan(layout.secondSection.left);
          } else {
            expect(layout.firstSection.bottom).toBeLessThan(layout.secondSection.top);
          }
          layouts.set(renderName, {
            columns: layout.main.columns,
            firstSection: layout.firstSection,
            secondSection: layout.secondSection,
          });

          const segment = frame.locator('#segment-one');
          const transition = await segment.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              backgroundColor: style.backgroundColor,
              duration: style.transitionDuration,
              property: style.transitionProperty,
            };
          });
          expect(await frame.locator('#choice-one').getAttribute('aria-pressed')).toBe('false');
          const transitionSeconds = Number.parseFloat(transition.duration);
          expect(transitionSeconds).toBeGreaterThan(0.2);
          expect(transitionSeconds).toBeLessThan(1);

          if (renderCase.reducedMotion === 'no-preference') {
            expect(await translateY(frame)).toBe(0);
            // Capture the real CSS transition in the click task, before CI scheduling can
            // skip its intermediate frames. Seek its own timeline without changing the CSS.
            await segment.evaluate((element) => {
              document.querySelector('#choice-one')!.addEventListener(
                'click',
                () => {
                  getComputedStyle(element).translate;
                  const animation = element
                    .getAnimations()
                    .find(
                      (candidate) =>
                        (candidate as Animation & { transitionProperty?: string })
                          .transitionProperty === 'translate',
                    );
                  if (!animation) return;
                  animation.pause();
                  animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
                  (
                    window as unknown as { __reachTranslateTransition?: Animation }
                  ).__reachTranslateTransition = animation;
                },
                { once: true },
              );
            });
          }

          await frame.locator('#choice-one').click();
          await expect
            .poll(() => frame.locator('#choice-one').getAttribute('aria-pressed'))
            .toBe('true');
          await expect.poll(() => frame.locator('#equation').textContent()).toBe('1/4');
          await expect
            .poll(() => frame.locator('#feedback').textContent())
            .toContain('One more fourth');
          const selectedBackground = await frame
            .locator('#choice-one')
            .evaluate((element) => getComputedStyle(element).backgroundColor);
          expect(selectedBackground).not.toBe('rgb(255, 255, 255)');

          if (renderCase.reducedMotion === 'no-preference') {
            expect(transition.property).toBe('all');
            const animationState = await frame.evaluate(async () => {
              const animation = (window as unknown as { __reachTranslateTransition?: Animation })
                .__reachTranslateTransition;
              if (!animation) return null;
              await animation.ready;
              return animation.playState;
            });
            expect(animationState).toBe('paused');
            const intermediateY = await translateY(frame);
            expect(intermediateY).toBeLessThan(-0.1);
            expect(intermediateY).toBeGreaterThan(-7.9);
            await frame.evaluate(async () => {
              const animation = (window as unknown as { __reachTranslateTransition: Animation })
                .__reachTranslateTransition;
              animation.play();
              await animation.finished;
            });
            await expect.poll(() => translateY(frame)).toBeCloseTo(-8, 0);
          } else {
            const reducedTransition = await segment.evaluate((element) => ({
              animations: element.getAnimations().length,
              property: getComputedStyle(element).transitionProperty,
            }));
            expect(reducedTransition.property).toBe('none');
            expect(reducedTransition.animations).toBe(0);
            expect(await translateY(frame)).toBeCloseTo(-8, 1);
          }
          expect(
            await segment.evaluate((element) => getComputedStyle(element).backgroundColor),
          ).not.toBe(transition.backgroundColor);

          await expect
            .poll(async () => {
              const messages = await readMessages(page);
              return messages.some(
                (message) =>
                  message.type === 'interaction' &&
                  JSON.stringify(message.payload) ===
                    JSON.stringify({
                      name: 'fraction_selected',
                      eventVersion: 1,
                      payload: { choice: 'one', selected_count: 1 },
                    }),
              );
            })
            .toBe(true);
          await expect
            .poll(async () => {
              const messages = await readMessages(page);
              return messages.some(
                (message) =>
                  message.type === 'stateChange' &&
                  JSON.stringify(message.payload) ===
                    JSON.stringify({ selected: ['one'], complete: false }),
              );
            })
            .toBe(true);

          if (renderName === 'teacher-desktop') {
            await frame.locator('#choice-two').click();
            await expect.poll(() => frame.locator('#equation').textContent()).toBe('2/4');
            await expect
              .poll(() => frame.locator('#feedback').textContent())
              .toContain('same amount as 1/2');
            await expect
              .poll(async () => {
                const messages = await readMessages(page);
                return messages.some(
                  (message) =>
                    message.type === 'stateChange' &&
                    JSON.stringify(message.payload) ===
                      JSON.stringify({ selected: ['one', 'two'], complete: true }),
                );
              })
              .toBe(true);
          }

          const messages = await readMessages(page);
          expect(messages[0]).toMatchObject({
            origin: 'null',
            type: 'bridge_ready',
            payload: {},
          });
          expect(messages).toContainEqual(
            expect.objectContaining({
              origin: 'null',
              type: 'ready',
              payload: { restored: false },
            }),
          );
          expect(
            messages.every(
              ({ channel, nonce, origin: messageOrigin, version }) =>
                channel === INTERACTIVE_CHANNEL &&
                version === INTERACTIVE_BRIDGE_VERSION &&
                nonce === NONCE &&
                messageOrigin === 'null',
            ),
          ).toBe(true);

          const screenshotPath = path.join(ARTIFACT_DIRECTORY, `${renderName}.png`);
          const screenshot = await page.screenshot({ path: screenshotPath, type: 'png' });
          expect(screenshot.byteLength).toBeGreaterThan(10_000);
          expect(pngDimensions(screenshot)).toEqual(renderCase.viewport);

          if (renderName === 'teacher-desktop') {
            await frame.locator('#reset').click();
            await expect.poll(() => frame.locator('#equation').textContent()).toBe('0/4');
            await expect
              .poll(() => frame.locator('#choice-one').getAttribute('aria-pressed'))
              .toBe('false');
            await expect
              .poll(async () => {
                const resetMessages = await readMessages(page);
                return resetMessages.some(
                  (message) =>
                    message.type === 'reset' &&
                    JSON.stringify(message.payload) === JSON.stringify({ attempt: 2 }),
                );
              })
              .toBe(true);
            await expect
              .poll(async () => {
                const resetMessages = await readMessages(page);
                return resetMessages.some(
                  (message) =>
                    message.type === 'stateChange' &&
                    JSON.stringify(message.payload) ===
                      JSON.stringify({ selected: [], complete: false }),
                );
              })
              .toBe(true);
            await frame.evaluate(() => window.dispatchEvent(new Event('pagehide')));
            expect(
              await frame.locator('html').getAttribute('data-resize-observer-disconnected'),
            ).toBe('true');
          }

          expect(runtimeRequests.slice(runtimeRequestCount)).toEqual([
            { render: renderName, origin: 'null' },
          ]);
          const parsedRequests = requestedUrls.map((url) => {
            const parsedUrl = new URL(url);
            return { origin: parsedUrl.origin, pathname: parsedUrl.pathname };
          });
          expect(parsedRequests.every((request) => request.origin === origin)).toBe(true);
          expect(
            parsedRequests.every(({ pathname }) =>
              [hostPath, tailwindRuntime.scriptPath, '/favicon.ico'].includes(pathname),
            ),
          ).toBe(true);
          expect(parsedRequests.filter(({ pathname }) => pathname === hostPath)).toEqual([
            { origin, pathname: hostPath },
          ]);
          // The server-side assertion above is authoritative for the exact iframe runtime request:
          // Playwright can omit that subresource from page request events under saturated CI.
          expect(
            parsedRequests.filter(({ pathname }) => pathname === tailwindRuntime.scriptPath).length,
          ).toBeLessThanOrEqual(1);
          expect(
            parsedRequests.filter(({ pathname }) => pathname === '/favicon.ico').length,
          ).toBeLessThanOrEqual(1);
          expect(failedRequests).toEqual([]);
          expect(failedResponses).toEqual([]);
          expect(consoleErrors).toEqual([]);
          expect(pageErrors).toEqual([]);
        } finally {
          await page.close();
          await context.close();
        }
      }

      for (const surface of ['teacher', 'student'] as const) {
        const desktop = layouts.get(`${surface}-desktop`);
        const narrow = layouts.get(`${surface}-narrow`);
        expect(desktop).toBeDefined();
        expect(narrow).toBeDefined();
        expect(desktop?.columns).not.toBe(narrow?.columns);
        expect(desktop!.firstSection.right).toBeLessThan(desktop!.secondSection.left);
        expect(narrow!.firstSection.bottom).toBeLessThan(narrow!.secondSection.top);
      }
      expect(runtimeRequests).toHaveLength(4);
      expect(unknownServerRequests).toEqual([]);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }, 120_000);
});
