/** All-page screenshots and resource/render checks against a prepared real Player harness. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { parseReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import {
  resolveDeckHarnessAiRuntimeUrl,
  resolveDeckHarnessOutputDirectory,
} from './deck-harness.js';
import { captureLocatorNonblank } from './player-harness-smoke.js';
import { inspectTextFrameInk } from './visual-text-ink.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.includes('--help')) {
  console.log(
    'tsx scripts/reach-deck/run-deck-harness-visual-browser.ts --origin http://127.0.0.1:16206 --output-dir tmp/deck-visual-browser\nUse a Player harness served from the real generated document. Captures every slide at desktop/mobile sizes and reports browser/media failures; screenshots still require visual review.',
  );
} else {
  await main();
}

async function main() {
  for (let index = 0; index < args.length; index += 2) {
    if (!['--origin', '--output-dir'].includes(args[index]!) || !args[index + 1])
      throw new Error('Unknown or missing argument');
  }
  const option = (key: string, fallback: string) =>
    args.indexOf(key) < 0 ? fallback : args[args.indexOf(key) + 1]!;
  const origin = resolveDeckHarnessAiRuntimeUrl(option('--origin', 'http://127.0.0.1:16206'));
  const output = resolveDeckHarnessOutputDirectory(
    option('--output-dir', 'tmp/deck-visual-browser'),
  );
  await mkdir(output, { recursive: true });
  const response = await fetch(`${origin}/document.json`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Prepared Player document is unavailable');
  const document = parseReachDeckDocumentV2(await response.json());
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.REACH_DECK_HTML_CHROME_PATH
      ? { executablePath: path.resolve(process.env.REACH_DECK_HTML_CHROME_PATH) }
      : process.platform === 'linux'
        ? { executablePath: '/usr/bin/chromium' }
        : { channel: 'chrome' }),
  });
  const failures: string[] = [];
  const evidence: unknown[] = [];
  try {
    for (const profile of [
      { name: 'desktop', viewport: { width: 1400, height: 1000 } },
      { name: 'mobile', viewport: { width: 390, height: 844 } },
    ]) {
      const page = await browser.newPage({ viewport: profile.viewport, deviceScaleFactor: 1 });
      let currentPage = 'loading';
      page.on('pageerror', (error) =>
        failures.push(`${profile.name}/${currentPage}: ${error.message}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error')
          failures.push(`${profile.name}/${currentPage}: ${message.text()}`);
      });
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith(`${origin}/`) || /^(data|blob|about):/.test(url)) await route.continue();
        else {
          failures.push(`${profile.name}/${currentPage}: unexpected external request`);
          await route.abort('blockedbyclient');
        }
      });
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-harness-player]');
        for (const [index, item] of [...document.pages]
          .sort((a, b) => a.order - b.order)
          .entries()) {
          currentPage = item.pageId;
          const scientific = document.nativeSlides
            .find((binding) => binding.pageId === item.pageId)
            ?.slide.elements.some((element) => element.type === 'scientificVisual');
          await page
            .locator('[data-harness-page-id]')
            .filter({ hasText: item.title })
            .first()
            .click();
          await page.waitForFunction(
            (id) =>
              (window as unknown as { __REACH_DECK_HARNESS_STATE__?: { activePageId?: string } })
                .__REACH_DECK_HARNESS_STATE__?.activePageId === id,
            item.pageId,
          );
          await page.waitForSelector('[data-native-v2-slide-renderer]');
          await page.evaluate(() => window.document.fonts.ready);
          // The Player resets timeline state after the controlled page switch commits.
          await page.waitForTimeout(250);
          const timeline = page.locator(
            '[data-reach-deck-timeline="native-v2"] input[type="range"]',
          );
          if (await timeline.count()) {
            const target = Number(await timeline.getAttribute('max')) * 0.95;
            await timeline.evaluate((element) => {
              const input = element as HTMLInputElement;
              const target = Number(input.max) * 0.95;
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
                input,
                String(target),
              );
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await page.waitForFunction(
              (expected) =>
                Math.abs(
                  (window as unknown as { __REACH_DECK_HARNESS_STATE__: { currentTime: number } })
                    .__REACH_DECK_HARNESS_STATE__.currentTime - expected,
                ) < 0.08,
              target,
            );
          }
          if (scientific)
            await page.waitForSelector('.scientific-visual-player[data-scientific-phase="active"]');
          await page.waitForTimeout(scientific ? 1000 : 250);
          const stage = page.locator('[data-native-v2-slide-renderer]').first();
          const imageStates = await stage.locator('img').evaluateAll((images) =>
            images.map((element) => {
              const image = element as HTMLImageElement;
              return {
                loaded: image.complete && image.naturalWidth > 0,
                width: image.naturalWidth,
                height: image.naturalHeight,
              };
            }),
          );
          if (imageStates.some((image) => !image.loaded))
            failures.push(`${profile.name}/${item.pageId}: image failed to decode`);
          const diagnostics = await stage
            .locator('[data-native-v2-text-overflow]')
            .evaluateAll(inspectTextFrameInk);
          const unsafeOverflow = diagnostics.filter((entry) => !entry.lineBoxOnly);
          if (unsafeOverflow.length)
            failures.push(
              `${profile.name}/${item.pageId}: ${unsafeOverflow.length} text overflow diagnostics`,
            );
          const viewportBounds = await stage.boundingBox();
          if (
            !viewportBounds ||
            viewportBounds.width < 100 ||
            viewportBounds.x < -1 ||
            viewportBounds.x + viewportBounds.width > profile.viewport.width + 1
          )
            failures.push(`${profile.name}/${item.pageId}: slide viewport outside screen`);
          const screenshot = await captureLocatorNonblank(
            stage,
            path.join(output, `${profile.name}-page-${index + 1}.png`),
            1000,
          );
          const scienceFrames = await stage.locator('[data-scientific-frame]').count();
          if (scientific && scienceFrames === 0)
            failures.push(`${profile.name}/${item.pageId}: missing scientific frame`);
          evidence.push({
            profile: profile.name,
            pageId: item.pageId,
            title: item.title,
            imageStates,
            diagnostics,
            scientific,
            scienceFrames,
            screenshot,
            viewportBounds,
          });
        }
      } catch (error) {
        failures.push(
          `${profile.name}/${currentPage}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await writeFile(
      path.join(output, 'all-page-report.json'),
      JSON.stringify(
        {
          failures,
          evidence,
          visualReview: 'pending',
          scientificSeekReplay: 'run standard player-harness --smoke separately',
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (failures.length)
    throw new Error(`All-page browser checks found ${failures.length} failures; inspect ${output}`);
  console.log(
    `All ${document.pages.length} pages rendered at desktop/mobile sizes. Inspect screenshots in ${output}; automatic checks do not certify semantic correctness or all text overlaps.`,
  );
}
