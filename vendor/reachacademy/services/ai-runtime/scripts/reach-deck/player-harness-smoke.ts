import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { chromium, type Locator, type Page } from 'playwright-core';
import {
  INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES,
  projectScientificVisualFrame,
} from '@reachany/reach-deck-player';

import type { PreparedPlayerHarness } from './player-harness.js';
import { scientificSmokeSeekTimes } from './player-harness-scientific-timing.js';

interface PixelEvidence {
  bytes: number;
  channelSpread: number;
  checksumSha256: string;
}

interface SmokeEvidence {
  profile: string;
  state: string;
  detail: unknown;
}

const paeth = (left: number, up: number, upperLeft: number): number => {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
};

const pngPixelSpread = (png: Buffer): number => {
  const signature = '89504e470d0a1a0a';
  if (png.subarray(0, 8).toString('hex') !== signature) throw new Error('Screenshot is not PNG.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (width <= 0 || height <= 0 || bitDepth !== 8 || channels === 0) {
    throw new Error(
      `Unsupported screenshot PNG format ${width}x${height}, depth ${bitDepth}, type ${colorType}.`,
    );
  }
  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const minimum = [255, 255, 255];
  const maximum = [0, 0, 0];
  let packedOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = packed[packedOffset++]!;
    for (let x = 0; x < stride; x += 1) {
      const encoded = packed[packedOffset++]!;
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upperLeft = x >= channels ? previous[x - channels]! : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upperLeft)
                  : NaN;
      if (!Number.isFinite(predictor)) throw new Error(`Unsupported PNG filter ${filter}.`);
      current[x] = (encoded + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 200))) {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = current[x * channels + channel]!;
        minimum[channel] = Math.min(minimum[channel]!, value);
        maximum[channel] = Math.max(maximum[channel]!, value);
      }
    }
    current.copy(previous);
  }
  return Math.max(...maximum.map((value, index) => value - minimum[index]!));
};

export const captureLocatorNonblank = async (
  locator: Locator,
  outputFile: string,
  minimumBytes = 10_000,
): Promise<PixelEvidence> => {
  const bytes = await locator.screenshot({ path: outputFile });
  const channelSpread = pngPixelSpread(bytes);
  if (bytes.length < minimumBytes || channelSpread < 24) {
    throw new Error(
      `Screenshot ${path.basename(outputFile)} is blank (${bytes.length} bytes, spread ${channelSpread}).`,
    );
  }
  return {
    bytes: bytes.length,
    channelSpread,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

const captureNonblank = async (page: Page, outputFile: string): Promise<PixelEvidence> =>
  captureLocatorNonblank(page.locator('[data-harness-player]'), outputFile);

const waitForScientificPaint = async (page: Page): Promise<void> => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  // Presentation crosses an opaque iframe postMessage boundary; parent RAFs
  // alone can precede the child's paint after an audio seek.
  for (const child of page.frames().filter((candidate) => candidate !== page.mainFrame())) {
    await child.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }
};

const seekNativeTimeline = async (page: Page, time: number): Promise<void> => {
  const range = page.locator('[data-reach-deck-timeline="native-v2"] input[type="range"]');
  await range.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      String(value),
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, time);
  await page.waitForFunction(
    (expected) =>
      Math.abs(
        (window as unknown as { __REACH_DECK_HARNESS_STATE__: { currentTime: number } })
          .__REACH_DECK_HARNESS_STATE__.currentTime - expected,
      ) < 0.08,
    time,
  );
};

export const runReachDeckPlayerHarnessSmoke = async (
  prepared: PreparedPlayerHarness,
  origin: string,
  options: { acceptanceKitIdsByPageId?: Readonly<Record<string, string>> } = {},
): Promise<{ evidence: SmokeEvidence[]; failures: string[] }> => {
  const browser = await chromium.launch();
  const evidence: SmokeEvidence[] = [];
  const failures: string[] = [];
  const scientificPage = prepared.document.pages.find((page) =>
    prepared.document.nativeSlides
      .find((binding) => binding.pageId === page.pageId)
      ?.slide.elements.some((element) => element.type === 'scientificVisual'),
  );
  const scientificBinding = prepared.document.nativeSlides.find(
    (binding) => binding.pageId === scientificPage?.pageId,
  );
  const targetBinding =
    scientificBinding ??
    prepared.document.nativeSlides.find((binding) =>
      prepared.document.pages.some((page) => page.pageId === binding.pageId),
    );
  const targetPage = prepared.document.pages.find((page) => page.pageId === targetBinding?.pageId);
  const observedAnimation =
    targetBinding?.slide.animations.find((animation) =>
      animation.id.startsWith('harness-preview:'),
    ) ?? targetBinding?.slide.animations[0];
  const scientificElements =
    scientificBinding?.slide.elements.filter((element) => element.type === 'scientificVisual') ??
    [];
  const expectsFunctionPlot = scientificElements.some((element) =>
    element.manifest.dependencies.some((dependency) => dependency.id === 'function-plot'),
  );
  const expectsFixtureScientificProbe =
    prepared.config.source === 'fixture' && scientificElements.length > 0;
  const requestedInteractiveRuntimeIds = new Set(
    prepared.document.pages.flatMap((candidate) =>
      candidate.sceneType === 'interactive'
        ? (candidate.scene.runtimeDependencies ?? []).map(({ id }) => id)
        : [],
    ),
  );
  const expectedExternalRuntimes = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.filter(({ id }) =>
    requestedInteractiveRuntimeIds.has(id),
  );

  try {
    for (const profile of [
      { name: 'desktop', viewport: { width: 1280, height: 800 } },
      { name: 'mobile', viewport: { width: 390, height: 844 } },
    ]) {
      const page = await browser.newPage({ viewport: profile.viewport, deviceScaleFactor: 1 });
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const externalRequests: string[] = [];
      const requests: string[] = [];
      let currentInteractivePageId: string | undefined;
      await page.addInitScript(() => {
        (
          window as unknown as { __HARNESS_SCIENTIFIC_MESSAGES__: unknown[] }
        ).__HARNESS_SCIENTIFIC_MESSAGES__ = [];
        window.addEventListener('message', (event) => {
          const record = event.data as { type?: string } | undefined;
          if (record?.type === 'harness_scientific_present') {
            (
              window as unknown as { __HARNESS_SCIENTIFIC_MESSAGES__: unknown[] }
            ).__HARNESS_SCIENTIFIC_MESSAGES__.push(record);
          }
        });
      });
      page.on('console', (message) => {
        if (message.type() === 'error')
          consoleErrors.push(`${currentInteractivePageId ?? 'player'}: ${message.text()}`);
      });
      page.on('pageerror', (error) =>
        pageErrors.push(`${currentInteractivePageId ?? 'player'}: ${error.stack ?? error.message}`),
      );
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith(origin) || /^(data|blob|about):/.test(url)) {
          requests.push(url);
          await route.continue();
        } else {
          externalRequests.push(url);
          await route.abort('blockedbyclient');
        }
      });
      try {
        // Audio resources are intentionally loaded by the real player and may keep the
        // local harness network busy while playback is prepared. `networkidle` therefore
        // makes this smoke test hang/timeout for otherwise healthy documents. Wait for the
        // document shell, then assert readiness through the player DOM below.
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-harness-player]', { state: 'attached' });
        if (targetPage !== undefined) {
          await page.locator(`[data-harness-page-id="${targetPage.pageId}"]`).click();
        }
        evidence.push({
          profile: profile.name,
          state: 'initial',
          detail: await captureNonblank(
            page,
            path.join(prepared.outputDirectory, `${profile.name}-initial.png`),
          ),
        });

        const timeline = page.locator('[data-reach-deck-timeline="native-v2"]');
        if ((await timeline.count()) > 0) {
          const frame = page.locator('[data-scientific-frame]');
          const duration = Number(
            await timeline.locator('input[type="range"]').getAttribute('max'),
          );
          if (scientificElements.length > 0) {
            const scientificVisibleAt = Math.max(
              0,
              ...targetBinding!.slide.animations
                .filter((animation) =>
                  scientificElements.some((element) => element.id === animation.targetId),
                )
                .map((animation) => animation.start + Math.max(animation.duration, 0.05) + 0.05),
            );
            const pausedSeekTime = Math.min(
              duration,
              Math.max(scientificVisibleAt, duration * 0.25),
            );
            await seekNativeTimeline(page, pausedSeekTime);
            await page.waitForSelector(
              '.scientific-visual-player[data-scientific-phase="active"] [data-scientific-frame]',
            );
            await waitForScientificPaint(page);
            await page.waitForTimeout(250);
            const pausedSeekSurface = await captureLocatorNonblank(
              frame,
              path.join(prepared.outputDirectory, `${profile.name}-scientific-paused-seek.png`),
              1_000,
            );
            evidence.push({
              profile: profile.name,
              state: 'scientific-paused-seek',
              detail: {
                playing: await page.locator('[data-harness-playing]').textContent(),
                time: pausedSeekTime,
                image: pausedSeekSurface,
              },
            });
            if ((await page.locator('[data-harness-playing]').textContent()) !== 'paused') {
              failures.push(
                `${profile.name}: paused scientific seek unexpectedly started playback.`,
              );
            }
          }
          const play = page.getByRole('button', { name: '播放' });
          await play.click();
          if (scientificElements.length > 0) {
            await page.waitForSelector(
              '.scientific-visual-player[data-scientific-phase="active"] [data-scientific-frame]',
            );
          }
          const initialNonce =
            scientificElements.length === 0
              ? null
              : await frame.getAttribute('data-scientific-nonce');
          await page.waitForFunction(
            () =>
              (
                window as unknown as {
                  __REACH_DECK_HARNESS_STATE__: { currentTime: number };
                }
              ).__REACH_DECK_HARNESS_STATE__.currentTime > 0.25,
          );
          evidence.push({
            profile: profile.name,
            state: 'mid-playing',
            detail: await captureNonblank(
              page,
              path.join(prepared.outputDirectory, `${profile.name}-mid-playing.png`),
            ),
          });
          await page.getByRole('button', { name: '暂停' }).click();

          const forwardTime = Math.min(
            duration,
            observedAnimation === undefined
              ? Math.max(0, duration * 0.75)
              : observedAnimation.start + Math.max(observedAnimation.duration, 0.05) + 0.05,
          );
          const backwardTime = Math.max(
            0,
            observedAnimation === undefined ? Math.min(0.05, duration) : observedAnimation.start,
          );
          await seekNativeTimeline(page, forwardTime);
          const finalStyle =
            observedAnimation === undefined
              ? undefined
              : await page
                  .locator(`[data-native-v2-element-id="${observedAnimation.targetId}"]`)
                  .evaluate((element) => ({
                    opacity: getComputedStyle(element).opacity,
                    transform: getComputedStyle(element).transform,
                  }));
          evidence.push({
            profile: profile.name,
            state: 'forward-seek',
            detail: {
              image: await captureNonblank(
                page,
                path.join(prepared.outputDirectory, `${profile.name}-forward-seek.png`),
              ),
              style: finalStyle,
              time: forwardTime,
            },
          });
          await seekNativeTimeline(page, backwardTime);
          const initialStyle =
            observedAnimation === undefined
              ? undefined
              : await page
                  .locator(`[data-native-v2-element-id="${observedAnimation.targetId}"]`)
                  .evaluate((element) => ({
                    opacity: getComputedStyle(element).opacity,
                    transform: getComputedStyle(element).transform,
                  }));
          evidence.push({
            profile: profile.name,
            state: 'backward-seek',
            detail: {
              image: await captureNonblank(
                page,
                path.join(prepared.outputDirectory, `${profile.name}-backward-seek.png`),
              ),
              style: initialStyle,
              time: backwardTime,
            },
          });
          if (
            observedAnimation !== undefined &&
            JSON.stringify(initialStyle) === JSON.stringify(finalStyle)
          ) {
            failures.push(`${profile.name}: native animation style did not change across seek.`);
          }

          if (scientificElements.length > 0) {
            const scientificAnimationEnds = targetBinding!.slide.animations
              .filter((animation) =>
                scientificElements.some((element) => element.id === animation.targetId),
              )
              .map((animation) => animation.start + Math.max(animation.duration, 0.05) + 0.05);
            const scientificVisibleAt = Math.max(0, ...scientificAnimationEnds);
            const { early: earlyScientificTime, late: lateScientificTime } =
              scientificSmokeSeekTimes(
                targetBinding!.slide,
                scientificElements[0]!,
                duration,
                scientificVisibleAt,
              );
            await seekNativeTimeline(page, earlyScientificTime);
            await waitForScientificPaint(page);
            const earlyScientificSurface = await captureLocatorNonblank(
              frame,
              path.join(prepared.outputDirectory, `${profile.name}-scientific-early-seek.png`),
              1_000,
            );
            await seekNativeTimeline(page, lateScientificTime);
            await waitForScientificPaint(page);
            const lateScientificSurface = await captureLocatorNonblank(
              frame,
              path.join(prepared.outputDirectory, `${profile.name}-scientific-late-seek.png`),
              1_000,
            );
            evidence.push({
              profile: profile.name,
              state: 'scientific-seek',
              detail: {
                early: { time: earlyScientificTime, image: earlyScientificSurface },
                late: { time: lateScientificTime, image: lateScientificSurface },
              },
            });
            if (earlyScientificSurface.checksumSha256 === lateScientificSurface.checksumSha256) {
              failures.push(`${profile.name}: scientific surface did not change across seek.`);
            }
            const narrationAudio = page.locator('[data-harness-player] audio').first();
            if (targetBinding!.slide.narration?.audioResourceId) {
              await page.waitForFunction((expected) => {
                const audio = document.querySelector<HTMLAudioElement>(
                  '[data-harness-player] audio',
                );
                return (
                  !!audio &&
                  audio.readyState >= 1 &&
                  audio.error === null &&
                  Number.isFinite(audio.duration) &&
                  audio.duration > 0 &&
                  Math.abs(audio.currentTime - expected) < 0.15
                );
              }, lateScientificTime);
              evidence.push({
                profile: profile.name,
                state: 'scientific-audio-seek',
                detail: await narrationAudio.evaluate((node) => {
                  const audio = node as HTMLAudioElement;
                  return {
                    currentTime: audio.currentTime,
                    duration: audio.duration,
                    paused: audio.paused,
                    readyState: audio.readyState,
                    error: audio.error?.code ?? null,
                  };
                }),
              });
            }
            await page.waitForTimeout(200);
            const stablePausedSurface = await captureLocatorNonblank(
              frame,
              path.join(prepared.outputDirectory, `${profile.name}-scientific-stable-paused.png`),
              1_000,
            );
            if (stablePausedSurface.checksumSha256 !== lateScientificSurface.checksumSha256)
              failures.push(`${profile.name}: scientific surface moved while paused.`);
            await seekNativeTimeline(page, earlyScientificTime);
            await waitForScientificPaint(page);
            const repeatedEarlySurface = await captureLocatorNonblank(
              frame,
              path.join(prepared.outputDirectory, `${profile.name}-scientific-repeated-seek.png`),
              1_000,
            );
            if (repeatedEarlySurface.checksumSha256 !== earlyScientificSurface.checksumSha256)
              failures.push(
                `${profile.name}: scientific rewind did not restore deterministic state.`,
              );
            await page.getByRole('button', { name: '播放' }).click();
            await page.waitForFunction(
              (after) =>
                (window as unknown as { __REACH_DECK_HARNESS_STATE__: { currentTime: number } })
                  .__REACH_DECK_HARNESS_STATE__.currentTime > after,
              earlyScientificTime + 0.2,
            );
            await page.getByRole('button', { name: '暂停' }).click();
            const replayTime = await page.evaluate(
              () =>
                (window as unknown as { __REACH_DECK_HARNESS_STATE__: { currentTime: number } })
                  .__REACH_DECK_HARNESS_STATE__.currentTime,
            );
            evidence.push({
              profile: profile.name,
              state: 'scientific-pause-rewind-replay',
              detail: {
                pauseStable:
                  stablePausedSurface.checksumSha256 === lateScientificSurface.checksumSha256,
                rewindDeterministic:
                  repeatedEarlySurface.checksumSha256 === earlyScientificSurface.checksumSha256,
                resumedFrom: earlyScientificTime,
                replayTime,
              },
            });
            const scientificState = await page.evaluate(() => {
              const messages = (
                window as unknown as {
                  __HARNESS_SCIENTIFIC_MESSAGES__: Array<{
                    anchors?: unknown;
                    dependencyReady?: boolean;
                  }>;
                }
              ).__HARNESS_SCIENTIFIC_MESSAGES__;
              return {
                count: messages.length,
                dependencyReady: messages.some((message) => message.dependencyReady === true),
                hasAnchors: messages.some(
                  (message) => Array.isArray(message.anchors) && message.anchors.length > 0,
                ),
              };
            });
            const finalNonce = await frame.getAttribute('data-scientific-nonce');
            const bridge = {
              initialNonce,
              finalNonce,
              sameNonce: initialNonce !== null && initialNonce === finalNonce,
              pointerEvents: await frame.evaluate(
                (element) => getComputedStyle(element).pointerEvents,
              ),
              sandbox: await frame.getAttribute('sandbox'),
              tabIndex: await frame.getAttribute('tabindex'),
              fixtureProbeExpected: expectsFixtureScientificProbe,
              ...(expectsFixtureScientificProbe
                ? scientificState
                : {
                    narrationBindings:
                      targetBinding!.slide.narration?.scientificAnchorBindings ?? [],
                    projectedEarlyAnchors: projectScientificVisualFrame({
                      slide: targetBinding!.slide,
                      element: scientificElements[0]!,
                      currentTime: earlyScientificTime,
                      effectiveDuration: duration,
                    }).anchors,
                    projectedLateAnchors: projectScientificVisualFrame({
                      slide: targetBinding!.slide,
                      element: scientificElements[0]!,
                      currentTime: lateScientificTime,
                      effectiveDuration: duration,
                    }).anchors,
                  }),
            };
            evidence.push({ profile: profile.name, state: 'scientific-contract', detail: bridge });
            if (
              !bridge.sameNonce ||
              bridge.pointerEvents !== 'none' ||
              bridge.sandbox !== 'allow-scripts' ||
              bridge.tabIndex !== '-1' ||
              (expectsFixtureScientificProbe &&
                (!scientificState.hasAnchors || !scientificState.dependencyReady))
            ) {
              failures.push(
                `${profile.name}: scientific bridge/dependency contract failed: ${JSON.stringify(bridge)}`,
              );
            }
            if (expectsFixtureScientificProbe) {
              await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
              await page.waitForFunction(() => {
                const messages = (
                  window as unknown as {
                    __HARNESS_SCIENTIFIC_MESSAGES__: Array<{ currentTime?: number }>;
                  }
                ).__HARNESS_SCIENTIFIC_MESSAGES__;
                return messages.at(-1)?.currentTime === 0;
              });
              const printTime = await page.evaluate(() => {
                const messages = (
                  window as unknown as {
                    __HARNESS_SCIENTIFIC_MESSAGES__: Array<{ currentTime?: number }>;
                  }
                ).__HARNESS_SCIENTIFIC_MESSAGES__;
                return messages.at(-1)?.currentTime;
              });
              evidence.push({
                profile: profile.name,
                state: 'scientific-print-t0',
                detail: { currentTime: printTime },
              });
              await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
            }
          }
        }

        await page.goto(`${origin}/?reduced-motion=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-harness-player]', { state: 'attached' });
        if (scientificPage !== undefined) {
          await page.locator(`[data-harness-page-id="${scientificPage.pageId}"]`).click();
          await page.waitForSelector('.scientific-visual-player [data-scientific-frame]', {
            state: 'attached',
          });
          const reducedPhase = await page
            .locator('.scientific-visual-player')
            .getAttribute('data-scientific-phase');
          if (reducedPhase !== 'static' && reducedPhase !== 'active') {
            failures.push(
              `${profile.name}: reduced-motion scientific visual phase was ${reducedPhase}.`,
            );
          }
          const reducedScientificTime = await page.evaluate(() => {
            const messages = (
              window as unknown as {
                __HARNESS_SCIENTIFIC_MESSAGES__: Array<{ currentTime?: number }>;
              }
            ).__HARNESS_SCIENTIFIC_MESSAGES__;
            return messages.at(-1)?.currentTime;
          });
          if (expectsFixtureScientificProbe && reducedScientificTime !== 0) {
            failures.push(
              `${profile.name}: reduced-motion scientific frame was not t=0 (${String(reducedScientificTime)}).`,
            );
          }
          evidence.push({
            profile: profile.name,
            state: 'scientific-reduced-motion-t0',
            detail: {
              phase: reducedPhase,
              currentTime: reducedScientificTime,
              image: await captureNonblank(
                page,
                path.join(
                  prepared.outputDirectory,
                  `${profile.name}-scientific-reduced-motion-t0.png`,
                ),
              ),
            },
          });
        }

        const interactivePages = prepared.document.pages.filter(
          (candidate) => candidate.sceneType === 'interactive',
        );
        for (const interactivePage of interactivePages) {
          currentInteractivePageId = interactivePage.pageId;
          await page.locator(`[data-harness-page-id="${interactivePage.pageId}"]`).click();
          const interactiveFrame = page.locator(
            `[data-interactive-page-id="${interactivePage.pageId}"] iframe`,
          );
          await interactiveFrame.waitFor();
          try {
            await page.waitForFunction(
              (pageId) =>
                document
                  .querySelector(`[data-interactive-page-id="${pageId}"] iframe`)
                  ?.getAttribute('data-bridge-phase') === 'active',
              interactivePage.pageId,
              { timeout: 15_000 },
            );
          } catch (error) {
            throw new Error(
              `${interactivePage.pageId} bridge did not become active: ${JSON.stringify({
                bridgePhase: await interactiveFrame.getAttribute('data-bridge-phase'),
                errorCode: await interactiveFrame.getAttribute('data-error-code'),
                consoleErrors,
                pageErrors,
                requests,
                externalRequests,
              })}`,
              { cause: error },
            );
          }
          await page.waitForTimeout(150);
          const content = page.frameLocator(
            `[data-interactive-page-id="${interactivePage.pageId}"] iframe`,
          );
          const markerInfo = await content
            .locator('script[type="application/json"][data-reach-science-kit]')
            .evaluateAll((markers) =>
              markers.map((marker) => {
                const instanceId = marker.getAttribute('data-reach-science-kit') ?? '';
                const envelope = JSON.parse(marker.textContent ?? '{}') as {
                  kitId?: string;
                  spec?: {
                    structures?: Array<{ data?: string; format?: string }>;
                    tracks?: Array<{ features?: Array<{ id?: string }> }>;
                  };
                };
                const target = [
                  ...document.querySelectorAll('[data-reach-science-kit-target]'),
                ].find(
                  (candidate) =>
                    candidate.getAttribute('data-reach-science-kit-target') === instanceId,
                );
                return {
                  declaredPdbAtomCount:
                    envelope.spec?.structures?.reduce(
                      (count, structure) =>
                        count +
                        (structure.format === 'pdb'
                          ? (structure.data
                              ?.split(/\r?\n/)
                              .filter((line) => /^(ATOM  |HETATM)/.test(line)).length ?? 0)
                          : 0),
                      0,
                    ) ?? 0,
                  declaredPdbBondCount:
                    envelope.spec?.structures?.reduce(
                      (count, structure) =>
                        count +
                        (structure.format === 'pdb'
                          ? (structure.data
                              ?.split(/\r?\n/)
                              .filter((line) => line.startsWith('CONECT'))
                              .reduce(
                                (sum, line) =>
                                  sum + Math.max(0, line.trim().split(/\s+/).length - 2),
                                0,
                              ) ?? 0)
                          : 0),
                      0,
                    ) ?? 0,
                  declaredFeatureIds:
                    envelope.spec?.tracks?.flatMap(
                      (track) =>
                        track.features?.flatMap((feature) =>
                          typeof feature.id === 'string' ? [feature.id] : [],
                        ) ?? [],
                    ) ?? [],
                  instanceId,
                  kitId: envelope.kitId ?? 'unknown',
                  mounted: (target?.childElementCount ?? 0) > 0,
                  runtimeDiagnostics:
                    target instanceof HTMLElement
                      ? {
                          atomCount: target.dataset.reachScienceKitAtomCount,
                          bondCount: target.dataset.reachScienceKitBondCount,
                          graphBounds: target.dataset.reachScienceKitGraphBounds,
                          graphViewport: target.dataset.reachScienceKitGraphViewport,
                          graphZoom: target.dataset.reachScienceKitGraphZoom,
                          selectedNodes: target.dataset.reachScienceKitSelectedNodes,
                          sequenceScrollLeft: target.dataset.reachScienceKitSequenceScrollLeft,
                          sequenceZoom: target.dataset.reachScienceKitSequenceZoom,
                          taskComplete: target.dataset.reachScienceKitTaskComplete,
                          taskProgress: target.dataset.reachScienceKitTaskProgress,
                        }
                      : {},
                };
              }),
            );
          if (markerInfo.some(({ mounted }) => !mounted)) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} has an unmounted science kit target.`,
            );
          }
          for (const marker of markerInfo) {
            if (
              marker.kitId === 'molecule-3d' &&
              marker.declaredPdbAtomCount > 0 &&
              (Number(marker.runtimeDiagnostics.atomCount) < marker.declaredPdbAtomCount ||
                Number(marker.runtimeDiagnostics.bondCount) < marker.declaredPdbBondCount)
            ) {
              failures.push(
                `${profile.name}: ${interactivePage.pageId} did not load all declared PDB atoms and bonds: ${JSON.stringify(marker)}.`,
              );
            }
          }
          await content.locator('html').evaluate(() => {
            const state = window as unknown as {
              __REACH_SCIENCE_KIT_CHANGE_COUNT__?: number;
              __REACH_SCIENCE_KIT_CHANGE_DETAILS__?: unknown[];
            };
            state.__REACH_SCIENCE_KIT_CHANGE_COUNT__ = 0;
            state.__REACH_SCIENCE_KIT_CHANGE_DETAILS__ = [];
            for (const target of document.querySelectorAll('[data-reach-science-kit-target]')) {
              target.addEventListener('reach-science-kit-change', (event) => {
                const state = window as unknown as {
                  __REACH_SCIENCE_KIT_CHANGE_COUNT__?: number;
                  __REACH_SCIENCE_KIT_CHANGE_DETAILS__?: unknown[];
                };
                state.__REACH_SCIENCE_KIT_CHANGE_COUNT__ =
                  (state.__REACH_SCIENCE_KIT_CHANGE_COUNT__ ?? 0) + 1;
                state.__REACH_SCIENCE_KIT_CHANGE_DETAILS__?.push(
                  (event as CustomEvent<unknown>).detail,
                );
              });
            }
          });
          if (markerInfo.some(({ kitId }) => kitId === 'bio-network')) {
            await content
              .locator('[data-reach-science-kit-target]')
              .filter({ has: content.locator('[data-reach-network-node-choice]') })
              .waitFor({ state: 'visible' });
            await content
              .locator(
                '[data-reach-science-kit-target][data-reach-science-kit-graph-bounds]:not([data-reach-science-kit-graph-bounds=""])',
              )
              .waitFor({ state: 'attached' });
            await content.locator('html').evaluate(async () => {
              const target = document.querySelector<HTMLElement>(
                '[data-reach-science-kit-target][data-reach-science-kit-graph-bounds]',
              );
              if (target === null) {
                throw new Error('bio-network did not publish graph bounds.');
              }
              const bounds = (target.dataset.reachScienceKitGraphBounds ?? '')
                .split(',')
                .map(Number);
              if (
                bounds.length !== 4 ||
                bounds.some((value) => !Number.isFinite(value)) ||
                bounds[2]! <= bounds[0]! ||
                bounds[3]! <= bounds[1]!
              ) {
                throw new Error(`bio-network published invalid graph bounds: ${bounds.join(',')}`);
              }
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
            });
          }
          const fileStem = `${profile.name}-interactive-${interactivePage.pageId}`;
          const before = await captureLocatorNonblank(
            interactiveFrame,
            path.join(prepared.outputDirectory, `${fileStem}-before.png`),
            1_000,
          );
          const scienceKitTarget = content.locator('[data-reach-science-kit-target]').first();
          const targetBefore =
            (await scienceKitTarget.count()) === 0
              ? undefined
              : await captureLocatorNonblank(
                  scienceKitTarget,
                  path.join(prepared.outputDirectory, `${fileStem}-target-before.png`),
                  1_000,
                );
          const hostLogStart = await page.evaluate(
            () =>
              (
                window as unknown as {
                  __REACH_DECK_HARNESS_STATE__: { logs: unknown[] };
                }
              ).__REACH_DECK_HARNESS_STATE__.logs.length,
          );
          let action = 'none';
          const primaryKitId = markerInfo.length === 1 ? markerInfo[0]!.kitId : undefined;
          const acceptanceKitId =
            options.acceptanceKitIdsByPageId?.[interactivePage.pageId] ??
            (interactivePage.pageId === `science-kit-${primaryKitId}` ? primaryKitId : undefined);
          const initialBridgeKitState = !['molecule-2d', 'bio-network'].includes(
            acceptanceKitId ?? '',
          )
            ? undefined
            : await content.locator('html').evaluate((_element, instanceId) => {
                const api = (
                  window as unknown as {
                    ReachScienceKits?: { getState: (id: string) => unknown };
                  }
                ).ReachScienceKits;
                return api?.getState(instanceId);
              }, markerInfo[0]!.instanceId);
          const range = content
            .locator('[data-reach-science-kit-target] input[type="range"]')
            .first();
          const button = content.locator('[data-reach-science-kit-target] button').first();
          const draggablePoint = content
            .locator('[data-reach-science-kit-target] [data-reach-point-draggable]')
            .first();
          const surface = content
            .locator('[data-reach-science-kit-target] canvas, [data-reach-science-kit-target] svg')
            .first();
          if (acceptanceKitId === 'geometry-board') {
            const box = await draggablePoint.boundingBox();
            if (box === null) throw new Error('geometry-board has no draggable point hit target.');
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 - 55, {
              steps: 10,
            });
            await page.mouse.up();
            await content.locator('[data-reach-point-draggable]').first().focus();
            await page.keyboard.press('ArrowRight');
            action = 'geometry-point-drag';
          } else if (acceptanceKitId === 'geo-map') {
            const mapSurface = content.locator('[data-reach-science-kit-target] svg').first();
            const box = await mapSurface.boundingBox();
            if (box === null) throw new Error('geo-map has no map surface.');
            await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.52);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.38, {
              steps: 10,
            });
            await page.mouse.up();
            await page.mouse.wheel(0, -320);
            await mapSurface.focus();
            await page.keyboard.press('ArrowRight');
            action = 'geo-rotate-zoom';
          } else if (acceptanceKitId === 'sequence-track') {
            await content.locator('[data-reach-sequence-zoom-in]').click();
            await page.waitForTimeout(80);
            const viewport = content.locator('[data-reach-sequence-viewport]');
            const box = await viewport.boundingBox();
            if (box === null) throw new Error('sequence-track has no viewport.');
            await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.48);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.48, {
              steps: 10,
            });
            await page.mouse.up();
            await viewport.focus();
            await page.keyboard.press('ArrowRight');
            for (const featureId of markerInfo[0]!.declaredFeatureIds) {
              await content.locator(`[data-reach-sequence-feature="${featureId}"]`).click();
            }
            action = 'sequence-zoom-pan-select';
          } else if (acceptanceKitId === 'molecule-2d') {
            const moleculeOrder =
              profile.name === 'mobile'
                ? ['dimethyl_ether', 'ethanol']
                : ['ethanol', 'dimethyl_ether'];
            for (const moleculeId of moleculeOrder) {
              await content
                .locator(
                  `[data-reach-molecule-atom-choice^="${moleculeId}:"][data-reach-molecule-element="O"]`,
                )
                .click();
            }
            action = 'molecule-oxygen-comparison';
          } else if (acceptanceKitId === 'bio-network') {
            const nodeOrder = profile.name === 'mobile' ? ['eagle', 'grass'] : ['grass', 'eagle'];
            for (const nodeId of nodeOrder) {
              await content.locator(`[data-reach-network-node-choice="${nodeId}"]`).click();
            }
            action = 'network-path-comparison';
          } else if (acceptanceKitId === 'dynamic-geometry') {
            const dynamicPoint = content.locator('[data-reach-dynamic-point-draggable]').first();
            const box = await dynamicPoint.boundingBox();
            if (box === null) throw new Error('dynamic-geometry has no free point hit target.');
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 - 45, {
              steps: 10,
            });
            await page.mouse.up();
            await dynamicPoint.focus();
            await page.keyboard.press('ArrowRight');
            action = 'dynamic-point-drag';
          } else if ((await range.count()) > 0) {
            await range.evaluate((element) => {
              const input = element as HTMLInputElement;
              const minimum = Number(input.min || '0');
              const maximum = Number(input.max || '100');
              input.value = String(minimum + (maximum - minimum) * 0.7);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            action = 'range-change';
          } else if ((await button.count()) > 0) {
            await button.click();
            action = 'button-click';
          } else {
            const hasDraggablePoint = (await draggablePoint.count()) > 0;
            const target = hasDraggablePoint
              ? draggablePoint
              : (await surface.count()) > 0
                ? surface
                : undefined;
            const box = await target?.boundingBox();
            if (box !== null && box !== undefined) {
              await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
              await page.mouse.down();
              await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.36, {
                steps: 8,
              });
              await page.mouse.up();
              action = hasDraggablePoint ? 'point-drag' : 'surface-drag';
            }
          }
          await page.waitForTimeout(250);
          const after = await captureLocatorNonblank(
            interactiveFrame,
            path.join(prepared.outputDirectory, `${fileStem}-after.png`),
            1_000,
          );
          const targetAfter =
            (await scienceKitTarget.count()) === 0
              ? undefined
              : await captureLocatorNonblank(
                  scienceKitTarget,
                  path.join(prepared.outputDirectory, `${fileStem}-target-after.png`),
                  1_000,
                );
          const documentState = await content.locator('html').evaluate((element) => {
            const html = element as HTMLElement;
            const body = document.body;
            const kitTarget = document.querySelector<HTMLElement>(
              '[data-reach-science-kit-target]',
            );
            const task = document.querySelector<HTMLElement>('[data-reach-interactive-task]');
            const progress = task?.querySelector<HTMLElement>(
              '[data-reach-interactive-task-progress]',
            );
            const result = task?.querySelector<HTMLElement>('[data-reach-interactive-task-result]');
            const kitRect = kitTarget?.getBoundingClientRect();
            const taskRect = task?.getBoundingClientRect();
            const authorOverlays =
              kitTarget === null
                ? []
                : [...document.body.querySelectorAll<HTMLElement>('*')].filter((element) => {
                    if (element === kitTarget || element.contains(kitTarget)) return false;
                    if (kitTarget.contains(element)) return false;
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return (
                      (style.position === 'absolute' || style.position === 'fixed') &&
                      style.display !== 'none' &&
                      style.visibility !== 'hidden' &&
                      Number(style.opacity) > 0 &&
                      rect.width > 0 &&
                      rect.height > 0
                    );
                  });
            const coveredKitControls =
              kitTarget === null
                ? []
                : [
                    ...kitTarget.querySelectorAll<HTMLElement>(
                      'button, input, select, textarea, [role="button"], [role="slider"]',
                    ),
                  ].filter((control) => {
                    const style = getComputedStyle(control);
                    const controlRect = control.getBoundingClientRect();
                    if (
                      style.display === 'none' ||
                      style.visibility === 'hidden' ||
                      Number(style.opacity) <= 0 ||
                      controlRect.width <= 0 ||
                      controlRect.height <= 0
                    ) {
                      return false;
                    }
                    return authorOverlays.some((overlay) => {
                      const overlayRect = overlay.getBoundingClientRect();
                      return (
                        controlRect.left < overlayRect.right &&
                        controlRect.right > overlayRect.left &&
                        controlRect.top < overlayRect.bottom &&
                        controlRect.bottom > overlayRect.top
                      );
                    });
                  });
            const visibleMoleculeIds =
              kitRect === undefined
                ? []
                : [
                    ...document.querySelectorAll<SVGElement>(
                      '[data-reach-molecule-atom-choice][data-reach-molecule-element="O"]',
                    ),
                  ]
                    .filter((choice) => {
                      const rect = choice.getBoundingClientRect();
                      const centerX = rect.left + rect.width / 2;
                      const centerY = rect.top + rect.height / 2;
                      return (
                        rect.width >= 44 &&
                        rect.height >= 44 &&
                        centerX >= kitRect.left &&
                        centerX <= kitRect.right &&
                        centerY >= kitRect.top &&
                        centerY <= kitRect.bottom
                      );
                    })
                    .map((choice) => (choice.dataset.reachMoleculeAtomChoice ?? '').split(':')[0]);
            return {
              changeEvents:
                (window as unknown as { __REACH_SCIENCE_KIT_CHANGE_COUNT__?: number })
                  .__REACH_SCIENCE_KIT_CHANGE_COUNT__ ?? 0,
              changeDetails:
                (
                  window as unknown as {
                    __REACH_SCIENCE_KIT_CHANGE_DETAILS__?: Array<Record<string, unknown>>;
                  }
                ).__REACH_SCIENCE_KIT_CHANGE_DETAILS__ ?? [],
              clientHeight: html.clientHeight,
              clientWidth: html.clientWidth,
              kitDiagnostics: {
                authorOverlayCount: authorOverlays.length,
                coveredKitControlCount: coveredKitControls.length,
                coveredKitControls: coveredKitControls.map((control) => ({
                  ariaLabel: control.getAttribute('aria-label'),
                  id: control.id,
                  tag: control.tagName.toLowerCase(),
                  text: control.textContent?.trim().slice(0, 80) ?? '',
                })),
                targetHeight: kitRect?.height,
                visibleMoleculeIds: [...new Set(visibleMoleculeIds)],
                selectedNodes: kitTarget?.dataset.reachScienceKitSelectedNodes,
                sequenceScrollLeft: kitTarget?.dataset.reachScienceKitSequenceScrollLeft,
                sequenceZoom: kitTarget?.dataset.reachScienceKitSequenceZoom,
                taskComplete: kitTarget?.dataset.reachScienceKitTaskComplete,
                taskProgress: kitTarget?.dataset.reachScienceKitTaskProgress,
              },
              kitTaskOverlap:
                kitRect !== undefined &&
                taskRect !== undefined &&
                kitRect.left < taskRect.right &&
                kitRect.right > taskRect.left &&
                kitRect.top < taskRect.bottom &&
                kitRect.bottom > taskRect.top,
              scrollHeight: Math.max(html.scrollHeight, body.scrollHeight),
              scrollWidth: Math.max(html.scrollWidth, body.scrollWidth),
              task: {
                complete: task?.dataset.reachInteractiveTaskComplete,
                exists: task !== null,
                progress: progress?.textContent?.trim() ?? '',
                result: result?.textContent?.trim() ?? '',
                resultVisible:
                  result !== null &&
                  result !== undefined &&
                  getComputedStyle(result).display !== 'none' &&
                  getComputedStyle(result).visibility !== 'hidden',
              },
              textLength: body.textContent?.trim().length ?? 0,
            };
          });
          if (
            documentState.scrollHeight > documentState.clientHeight + 2 ||
            documentState.scrollWidth > documentState.clientWidth + 2
          ) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} overflows its viewport: ${JSON.stringify(documentState)}`,
            );
          }
          if (documentState.kitTaskOverlap) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} science kit overlaps its task region.`,
            );
          }
          if (documentState.kitDiagnostics.coveredKitControlCount > 0) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} author overlay covers science-kit controls: ${JSON.stringify(documentState.kitDiagnostics.coveredKitControls)}.`,
            );
          }
          if (['range-change', 'button-click'].includes(action) && documentState.changeEvents < 1) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} performed ${action} without a science-kit change event.`,
            );
          }
          const changeKinds = documentState.changeDetails.map(({ kind }) => kind);
          const pixelsChanged = before.checksumSha256 !== after.checksumSha256;
          if (
            ['geometry-board', 'geo-map', 'sequence-track'].includes(acceptanceKitId ?? '') &&
            (!pixelsChanged || documentState.changeEvents < 1)
          ) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} ${action} did not change both runtime state and pixels.`,
            );
          }
          if (
            acceptanceKitId === 'geometry-board' &&
            !documentState.changeDetails.some(
              ({ kind, pointId }) => kind === 'point-moved' && pointId === 'C',
            )
          ) {
            failures.push(`${profile.name}: geometry-board did not move point C.`);
          }
          if (
            acceptanceKitId === 'geo-map' &&
            (!changeKinds.includes('rotation') || !changeKinds.includes('zoom'))
          ) {
            failures.push(`${profile.name}: geo-map did not emit both rotation and zoom.`);
          }
          if (
            acceptanceKitId === 'sequence-track' &&
            (!changeKinds.includes('zoom') ||
              !changeKinds.includes('pan') ||
              Number(documentState.kitDiagnostics.sequenceScrollLeft) <= 0 ||
              markerInfo[0]!.declaredFeatureIds.some(
                (featureId) =>
                  !documentState.changeDetails.some(
                    (detail) =>
                      detail.kind === 'feature-selected' && detail.featureId === featureId,
                  ),
              ))
          ) {
            failures.push(
              `${profile.name}: sequence-track did not complete zoom, pan, and all declared feature selections.`,
            );
          }
          if (acceptanceKitId === 'molecule-2d') {
            const oxygenSelections = documentState.changeDetails.filter(
              ({ kind, element }) => kind === 'atom-selected' && element === 'O',
            );
            const ethanol = oxygenSelections.find(({ moleculeId }) => moleculeId === 'ethanol');
            const dimethylEther = oxygenSelections.find(
              ({ moleculeId }) => moleculeId === 'dimethyl_ether',
            );
            if (
              oxygenSelections.length !== 2 ||
              ethanol?.carbonNeighborCount !== 1 ||
              dimethylEther?.carbonNeighborCount !== 2 ||
              Number(documentState.kitDiagnostics.targetHeight) < 120 ||
              [...documentState.kitDiagnostics.visibleMoleculeIds].sort().join(',') !==
                'dimethyl_ether,ethanol'
            ) {
              failures.push(
                `${profile.name}: molecule-2d exploration did not expose the 1-vs-2 oxygen comparison: ${JSON.stringify(documentState)}.`,
              );
            }
          }
          if (acceptanceKitId === 'bio-network') {
            const nodeSelections = documentState.changeDetails.filter(
              ({ kind }) => kind === 'node-selected',
            );
            const grass = nodeSelections.find(({ nodeId }) => nodeId === 'grass');
            const eagle = nodeSelections.find(({ nodeId }) => nodeId === 'eagle');
            if (
              !grass ||
              !eagle ||
              !Array.isArray(grass.outgoingIds) ||
              [...grass.outgoingIds].sort().join(',') !== 'grasshopper,rabbit' ||
              !Array.isArray(eagle.incomingIds) ||
              [...eagle.incomingIds].sort().join(',') !== 'frog,rabbit'
            ) {
              failures.push(
                `${profile.name}: bio-network exploration did not expose the grass/eagle path comparison: ${JSON.stringify(documentState)}.`,
              );
            }
          }
          const hostLogs = await page.evaluate(
            (start) =>
              (
                window as unknown as {
                  __REACH_DECK_HARNESS_STATE__: {
                    logs: Array<{ kind: string; detail: unknown }>;
                  };
                }
              ).__REACH_DECK_HARNESS_STATE__.logs.slice(start),
            hostLogStart,
          );
          const hostEvents = hostLogs
            .filter(({ kind }) => kind === 'event')
            .map(({ detail }) => detail as Record<string, unknown>);
          if (
            ['molecule-2d', 'bio-network'].includes(acceptanceKitId ?? '') &&
            (documentState.task.exists ||
              interactivePage.scene.runtimePolicy.completionMode !== 'none' ||
              hostEvents.some(({ type }) => type === 'interactiveComplete'))
          ) {
            failures.push(
              `${profile.name}: ${acceptanceKitId} exploration introduced a task or completion gate: ${JSON.stringify({ hostEvents, runtimePolicy: interactivePage.scene.runtimePolicy, task: documentState.task })}.`,
            );
          }
          const expectedBridgeKitState = !['molecule-2d', 'bio-network'].includes(
            acceptanceKitId ?? '',
          )
            ? undefined
            : await content.locator('html').evaluate(
                (_element, instanceId) =>
                  (
                    window as unknown as {
                      ReachScienceKits: { getState: (id: string) => unknown };
                    }
                  ).ReachScienceKits.getState(instanceId),
                markerInfo[0]!.instanceId,
              );
          const bridgeRuntimeSnapshot =
            expectedBridgeKitState === undefined
              ? undefined
              : await (async () => {
                  await page.waitForFunction(
                    ({ expected, pageId }) => {
                      const runtime = (
                        window as unknown as {
                          __REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__?: Record<
                            string,
                            { snapshot?: { kitState?: unknown } }
                          >;
                        }
                      ).__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__;
                      return (
                        JSON.stringify(runtime?.[pageId]?.snapshot?.kitState) ===
                        JSON.stringify(expected)
                      );
                    },
                    { expected: expectedBridgeKitState, pageId: interactivePage.pageId },
                  );
                  return page.evaluate(() =>
                    structuredClone(
                      (
                        window as unknown as {
                          __REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__: Record<string, unknown>;
                        }
                      ).__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__,
                    ),
                  );
                })();
          const runtimeRoundTrip =
            acceptanceKitId === undefined
              ? undefined
              : await content.locator('html').evaluate((_element, instanceId) => {
                  const api = (
                    window as unknown as {
                      ReachScienceKits?: {
                        getState: (id: string) => unknown;
                        setState: (id: string, state: unknown) => boolean;
                      };
                    }
                  ).ReachScienceKits;
                  if (api === undefined) return { available: false };
                  const before = api.getState(instanceId);
                  window.dispatchEvent(
                    new CustomEvent('reach-interactive-reset', { detail: { attempt: 999 } }),
                  );
                  const reset = api.getState(instanceId);
                  const accepted = api.setState(instanceId, before);
                  const after = api.getState(instanceId);
                  return {
                    accepted,
                    available: true,
                    changedByReset: JSON.stringify(before) !== JSON.stringify(reset),
                    restored: JSON.stringify(before) === JSON.stringify(after),
                  };
                }, markerInfo[0]!.instanceId);
          if (
            runtimeRoundTrip !== undefined &&
            (!runtimeRoundTrip.available ||
              !runtimeRoundTrip.accepted ||
              !runtimeRoundTrip.changedByReset ||
              !runtimeRoundTrip.restored)
          ) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} science-kit state did not survive reset/restore: ${JSON.stringify(runtimeRoundTrip)}.`,
            );
          }
          const bridgeRestore = !['molecule-2d', 'bio-network'].includes(acceptanceKitId ?? '')
            ? undefined
            : await (async () => {
                const expectedKitState = expectedBridgeKitState!;
                const remount = async (invalidKitState: boolean) => {
                  const previousNonce = await interactiveFrame.getAttribute('data-bridge-nonce');
                  await page.evaluate(
                    ({ invalid, pageId, runtimeSnapshot }) => {
                      const host = window as unknown as {
                        __REACH_DECK_HARNESS_REMOUNT__: (runtime?: Record<string, unknown>) => void;
                      };
                      const runtime = structuredClone(runtimeSnapshot) as Record<
                        string,
                        { snapshot?: Record<string, unknown> }
                      >;
                      if (invalid && runtime[pageId]?.snapshot)
                        runtime[pageId].snapshot.kitState = { invalid: true };
                      host.__REACH_DECK_HARNESS_REMOUNT__(runtime);
                    },
                    {
                      invalid: invalidKitState,
                      pageId: interactivePage.pageId,
                      runtimeSnapshot: bridgeRuntimeSnapshot!,
                    },
                  );
                  await page.waitForFunction(
                    ({ nonce, pageId }) => {
                      const frame = document.querySelector<HTMLIFrameElement>(
                        `[data-interactive-page-id="${pageId}"] iframe`,
                      );
                      return (
                        frame?.dataset.bridgeNonce !== nonce &&
                        frame?.dataset.bridgePhase === 'active'
                      );
                    },
                    { nonce: previousNonce, pageId: interactivePage.pageId },
                  );
                  const readyRestored = await interactiveFrame.getAttribute('data-bridge-restored');
                  if (!invalidKitState) return { readyRestored };
                  await page.waitForFunction((pageId) => {
                    const runtime = (
                      window as unknown as {
                        __REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__: Record<
                          string,
                          { completed?: boolean; snapshot?: unknown }
                        >;
                      }
                    ).__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__[pageId];
                    return (
                      runtime?.completed === false &&
                      !Object.prototype.hasOwnProperty.call(runtime, 'snapshot')
                    );
                  }, interactivePage.pageId);
                  const hostRuntime = await page.evaluate(
                    (pageId) =>
                      (
                        window as unknown as {
                          __REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__: Record<string, unknown>;
                        }
                      ).__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__[pageId],
                    interactivePage.pageId,
                  );
                  const childKitState = await content.locator('html').evaluate(
                    (_element, instanceId) =>
                      (
                        window as unknown as {
                          ReachScienceKits: { getState: (id: string) => unknown };
                        }
                      ).ReachScienceKits.getState(instanceId),
                    markerInfo[0]!.instanceId,
                  );
                  return { childKitState, hostRuntime, readyRestored };
                };
                const validReadyRestored = await remount(false);
                const restoredKitState = await content.locator('html').evaluate(
                  (_element, instanceId) =>
                    (
                      window as unknown as {
                        ReachScienceKits: { getState: (id: string) => unknown };
                      }
                    ).ReachScienceKits.getState(instanceId),
                  markerInfo[0]!.instanceId,
                );
                const invalidReadyRestored = await remount(true);
                return {
                  expectedKitState,
                  initialKitState: initialBridgeKitState,
                  invalidChildKitState: invalidReadyRestored.childKitState,
                  invalidHostRuntime: invalidReadyRestored.hostRuntime as
                    | { completed?: boolean; snapshot?: unknown }
                    | undefined,
                  invalidReadyRestored: invalidReadyRestored.readyRestored,
                  invalidKitStateReset:
                    JSON.stringify(initialBridgeKitState) ===
                    JSON.stringify(invalidReadyRestored.childKitState),
                  kitStateRestored:
                    JSON.stringify(expectedKitState) === JSON.stringify(restoredKitState),
                  restoredKitState,
                  validReadyRestored: validReadyRestored.readyRestored,
                };
              })();
          if (
            bridgeRestore !== undefined &&
            (bridgeRestore.validReadyRestored !== 'true' ||
              !bridgeRestore.kitStateRestored ||
              bridgeRestore.invalidReadyRestored !== 'false' ||
              !bridgeRestore.invalidKitStateReset ||
              bridgeRestore.invalidHostRuntime?.completed !== false ||
              Object.prototype.hasOwnProperty.call(
                bridgeRestore.invalidHostRuntime ?? {},
                'snapshot',
              ))
          ) {
            failures.push(
              `${profile.name}: ${interactivePage.pageId} bridge snapshot restore contract failed: ${JSON.stringify(bridgeRestore)}.`,
            );
          }
          const fixtureControl = content.locator('#adjust-and-complete');
          if ((await fixtureControl.count()) > 0) {
            await fixtureControl.click();
            await page.waitForFunction(() => {
              const events = (
                window as unknown as {
                  __REACH_DECK_HARNESS_STATE__: {
                    logs: Array<{ kind: string; detail: unknown }>;
                  };
                }
              ).__REACH_DECK_HARNESS_STATE__.logs
                .filter((entry) => entry.kind === 'event')
                .map((entry) => entry.detail as { type?: string });
              return (
                events.some((event) => event.type === 'interactiveLearningEvent') &&
                events.some((event) => event.type === 'interactiveComplete')
              );
            });
          }
          evidence.push({
            profile: profile.name,
            state: 'interactive-page',
            detail: {
              action,
              after,
              before,
              bridgePhase: await interactiveFrame.getAttribute('data-bridge-phase'),
              documentState,
              hostEvents,
              markerInfo,
              pixelsChanged,
              pageId: interactivePage.pageId,
              runtimeDependencies: interactivePage.scene.runtimeDependencies ?? [],
              runtimeRoundTrip,
              bridgeRestore,
              targetAfter,
              targetBefore,
            },
          });
        }

        const dependencyRequests = requests.filter((url) =>
          url.includes('/reach-deck-dependencies/'),
        );
        evidence.push({
          profile: profile.name,
          state: 'network',
          detail: { dependencyRequests, externalRequests, scientificMediaRequests: [] },
        });
        if (expectsFunctionPlot && dependencyRequests.length === 0)
          failures.push(`${profile.name}: function-plot was not requested.`);
        for (const runtime of expectedExternalRuntimes) {
          if (!dependencyRequests.some((url) => url.endsWith(runtime.scriptPath))) {
            failures.push(`${profile.name}: ${runtime.id} was not requested from its pinned path.`);
          }
        }
        if (
          scientificElements.length > 0 &&
          requests.some((url) => /poster|scientific-poster/i.test(url))
        )
          failures.push(`${profile.name}: scientific visual attempted a forbidden poster request.`);
        if (externalRequests.length > 0) {
          failures.push(
            `${profile.name}: external requests were attempted: ${externalRequests.join(', ')}`,
          );
        }
        if (consoleErrors.length > 0) {
          failures.push(`${profile.name}: console errors: ${consoleErrors.join(' | ')}`);
        }
        if (pageErrors.length > 0)
          failures.push(`${profile.name}: page errors: ${pageErrors.join(' | ')}`);
      } catch (error) {
        failures.push(
          `${profile.name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  const report = { evidence, failures };
  await writeFile(
    path.join(prepared.outputDirectory, 'smoke-evidence.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  if (failures.length > 0) throw new Error(`Player harness smoke failed:\n${failures.join('\n')}`);
  return report;
};
