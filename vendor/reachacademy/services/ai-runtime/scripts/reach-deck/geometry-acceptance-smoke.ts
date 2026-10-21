import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import type { GeometryEnvelope } from '@reachany/reach-deck-dsl/euclidean-geometry';
import type { GeometrySnapshot } from '@reachany/reach-deck-geometry';
import type { GeometryComputedState } from '@reachany/reach-deck-geometry/session';
import { chromium, type Frame, type Locator, type Page } from 'playwright-core';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';

import {
  assertGeometryAcceptanceSnapshot,
  geometryAcceptanceProbes,
  geometryAcceptancePrimaryMarkers,
  inspectAcceptanceScene,
  type GeometryAcceptanceCase,
} from './geometry-acceptance-cases.js';
import { captureLocatorNonblank } from './player-harness-smoke.js';
import type { PreparedPlayerHarness } from './player-harness.js';

export const GEOMETRY_ACCEPTANCE_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'mobile-landscape', width: 844, height: 390 },
] as const;
export interface GeometryAcceptanceBrowserEvidence {
  pageId: string;
  scenarioId: string;
  profile: string;
  status: 'passed' | 'failed' | 'review-required';
  observations: unknown[];
  error?: string;
}
const requireCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const computedState = (frame: Frame, instanceId: string): Promise<GeometryComputedState> =>
  frame.evaluate(
    (id) =>
      (
        window as unknown as {
          ReachScienceKits: { getComputedState(id: string): GeometryComputedState };
        }
      ).ReachScienceKits.getComputedState(id),
    instanceId,
  );

async function activeFrame(page: Page, pageId: string): Promise<Frame> {
  const locator = page.locator(`iframe[data-scene-id="${pageId}"][data-visible="true"]`);
  await page.waitForFunction(
    (id) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `iframe[data-scene-id="${id}"][data-visible="true"]`,
      );
      if (frame?.dataset.bridgePhase === 'failed')
        throw new Error(`Player failed: ${frame.dataset.errorCode}`);
      return frame?.dataset.bridgePhase === 'active';
    },
    pageId,
    { timeout: 15_000 },
  );
  const frame = await (await locator.elementHandle())?.contentFrame();
  if (!frame) throw new Error(`Missing active iframe for ${pageId}`);
  return frame;
}
async function reveal(input: Locator): Promise<void> {
  const details = input.locator('xpath=ancestor::details');
  for (let index = 0; index < (await details.count()); index++) {
    const ancestor = details.nth(index);
    if ((await ancestor.getAttribute('open')) === null)
      await ancestor.locator(':scope > summary').click();
  }
  await input.scrollIntoViewIfNeeded();
}
async function changeNumber(input: Locator, value: number): Promise<void> {
  await reveal(input);
  await input.fill(String(value));
  await input.press('Tab');
}

export function assertAcceptanceInputChanged(
  snapshot: GeometrySnapshot,
  field: string,
  expected: number,
): void {
  const [kind, id, axis] = field.split(':');
  const value =
    kind === 'parameter' ? snapshot.inputs.parameters[id!] : snapshot.inputs.freedoms[id!];
  const actual = axis && typeof value === 'object' ? value[axis] : value;
  requireCondition(
    typeof actual === 'number' &&
      Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)),
    `Control ${field} did not apply ${expected}; observed ${JSON.stringify(actual)}`,
  );
}

async function dragFreedoms(
  page: Page,
  frame: Frame,
  instanceId: string,
  envelope: GeometryEnvelope,
  scenario: GeometryAcceptanceCase,
  touch: boolean,
  observations: unknown[],
): Promise<void> {
  const root = frame.locator(`[data-geometry-instance="${instanceId}"]`);
  for (const freedom of envelope.spec.interaction.freedoms) {
    if (freedom.kind === 'translate') continue;
    await root.locator('[data-geometry-action="reset"]').click();
    const before = await computedState(frame, instanceId);
    const surface = root.locator('.reach-geometry-scene');
    await surface.scrollIntoViewIfNeeded();
    const bounds = await surface.boundingBox();
    requireCondition(bounds, 'Geometry has no visible drag surface');
    let x: number, y: number;
    if (before.camera.kind === 'planar') {
      const target = root.locator(`[data-reach-geometry-object="${freedom.object}"]`);
      const box = await target.boundingBox();
      requireCondition(box, `Point ${freedom.object} has no rendered drag target`);
      x = box!.x + box!.width / 2;
      y = box!.y + box!.height / 2;
    } else {
      const spec = before.camera;
      const distance = new Vector3()
        .fromArray(spec.position)
        .distanceTo(new Vector3().fromArray(spec.target));
      const half = Math.max(0.01, distance * Math.tan((21 * Math.PI) / 180));
      const aspect = bounds!.width / bounds!.height;
      const camera =
        spec.projection === 'perspective'
          ? new PerspectiveCamera(42, aspect, 0.00001, 100000)
          : new OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.00001, 100000);
      camera.position.fromArray(spec.position);
      camera.up.fromArray(spec.up);
      camera.lookAt(new Vector3().fromArray(spec.target));
      camera.zoom = spec.zoom;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const coordinates = before.objects[freedom.object]?.coordinates;
      requireCondition(coordinates, `Point ${freedom.object} is undefined before drag`);
      const projected = new Vector3().fromArray(coordinates!).project(camera);
      x = bounds!.x + ((projected.x + 1) * bounds!.width) / 2;
      y = bounds!.y + ((1 - projected.y) * bounds!.height) / 2;
    }
    let after = before;
    // A control starting at a boundary may legitimately clamp one drag direction.
    for (const direction of [1, -1]) {
      const destination = {
        x: Math.min(bounds!.x + bounds!.width - 8, Math.max(bounds!.x + 8, x + direction * 31)),
        y: Math.min(bounds!.y + bounds!.height - 8, Math.max(bounds!.y + 8, y + direction * 23)),
      };
      if (touch) {
        const client = await page.context().newCDPSession(page);
        try {
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y, id: 1 }],
          });
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ ...destination, id: 1 }],
          });
          await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } finally {
          await client.detach();
        }
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(destination.x, destination.y, { steps: 8 });
        await page.mouse.up();
      }
      after = await computedState(frame, instanceId);
      if (
        JSON.stringify(after.inputs.freedoms[freedom.id]) !==
        JSON.stringify(before.inputs.freedoms[freedom.id])
      )
        break;
    }
    requireCondition(
      JSON.stringify(after.inputs.freedoms[freedom.id]) !==
        JSON.stringify(before.inputs.freedoms[freedom.id]),
      `Dragging ${freedom.object} did not change its declared freedom`,
    );
    assertGeometryAcceptanceSnapshot(scenario.scenarioId, envelope, after);
    observations.push({
      kind: touch ? 'touch-drag' : 'pointer-drag',
      instanceId,
      freedom: freedom.id,
      before: before.inputs,
      after,
    });
  }
}

async function inspectLayout(frame: Frame): Promise<unknown> {
  const layout = await frame.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll<HTMLElement>('input,button,select,[data-reach-geometry-label]'),
    ];
    const visible = candidates.filter((element) => {
      const style = getComputedStyle(element),
        box = element.getBoundingClientRect();
      return (
        style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
      );
    });
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      clipped: visible
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < -2 || box.right > innerWidth + 2;
        })
        .map((element) => ({
          tag: element.tagName,
          label: element.getAttribute('aria-label') ?? element.textContent?.slice(0, 60),
        })),
    };
  });
  requireCondition(
    !layout.horizontalOverflow && layout.clipped.length === 0,
    `Controls/labels exceed viewport: ${JSON.stringify(layout)}`,
  );
  return layout;
}

async function interactCustom(
  page: Page,
  frame: Frame,
  scenario: GeometryAcceptanceCase,
  observations: unknown[],
): Promise<void> {
  if (scenario.scenarioId === 'control-function-plot') {
    const inputs = frame.locator('input[type="range"],input[type="number"]');
    let control: Locator | undefined;
    for (let index = 0; index < (await inputs.count()); index++) {
      const input = inputs.nth(index),
        min = Number(await input.getAttribute('min')),
        max = Number(await input.getAttribute('max'));
      if (min <= -2 && max >= 2) {
        control = input;
        break;
      }
    }
    requireCondition(control, 'Function plot must expose the requested coefficient control [-2,2]');
    for (const value of [-2, 0, 1, 2]) {
      if ((await control!.getAttribute('type')) === 'range') {
        await reveal(control!);
        await control!.focus();
        await control!.press('Home');
        const step = Number((await control!.getAttribute('step')) || 1);
        const minimum = Number((await control!.getAttribute('min')) || 0);
        const count = Math.round((value - minimum) / step);
        requireCondition(count <= 500, 'Function control keyboard step budget exceeded');
        for (let index = 0; index < count; index++) await control!.press('ArrowRight');
      } else await changeNumber(control!, value);
      observations.push({
        kind: 'coefficient',
        value,
        visibleText: (await frame.locator('body').innerText()).slice(0, 8000),
      });
    }
  } else if (scenario.scenarioId === 'control-open-polyline-editor') {
    const surface = frame.locator('canvas,svg').first();
    const box = await surface.boundingBox();
    requireCondition(
      box && box.width > 80 && box.height > 80,
      'Polyline editor has no usable drawing surface',
    );
    for (const [x, y] of [
      [0.2, 0.3],
      [0.5, 0.6],
      [0.8, 0.3],
    ])
      await surface.click({ position: { x: box!.width * x!, y: box!.height * y! } });
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.45, { steps: 8 });
    await page.mouse.up();
    await frame
      .getByRole('button', { name: /删除|delete/i })
      .first()
      .click();
    await frame
      .getByRole('button', { name: /撤销|undo/i })
      .first()
      .click();
    observations.push({
      kind: 'polyline-add-drag-delete-undo',
      visibleText: (await frame.locator('body').innerText()).slice(0, 8000),
    });
  } else {
    observations.push({
      kind: 'alternative-implementation',
      reviewRequired: true,
      reason:
        'Use the frozen case rubric to independently inspect this legal legacy/custom implementation.',
    });
  }
}

export async function runGeometryAcceptanceSmoke(
  prepared: PreparedPlayerHarness,
  origin: string,
  scenariosByPageId: Readonly<Record<string, GeometryAcceptanceCase>>,
): Promise<GeometryAcceptanceBrowserEvidence[]> {
  const evidence: GeometryAcceptanceBrowserEvidence[] = [];
  const browser = await chromium.launch();
  try {
    for (const profile of GEOMETRY_ACCEPTANCE_VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: 1,
        hasTouch: profile.name.startsWith('mobile'),
      });
      try {
        for (const [pageId, scenario] of Object.entries(scenariosByPageId)) {
          const page = await context.newPage();
          const entry: GeometryAcceptanceBrowserEvidence = {
            pageId,
            scenarioId: scenario.scenarioId,
            profile: profile.name,
            status: 'passed',
            observations: [],
          };
          evidence.push(entry);
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text());
          });
          await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) {
              errors.push(`Unexpected external origin ${url.origin}`);
              return route.abort();
            }
            return route.continue();
          });
          try {
            await page.goto(`${origin}/player.html`, { waitUntil: 'networkidle' });
            await page.locator(`[data-harness-page-id="${pageId}"]`).click();
            const candidate = prepared.document.pages.find((item) => item.pageId === pageId);
            requireCondition(candidate, `Document is missing ${pageId}`);
            const stem = `${pageId}--${profile.name}`;
            entry.observations.push({
              kind: 'before',
              image: await captureLocatorNonblank(
                page.locator('[data-harness-player]'),
                path.join(prepared.outputDirectory, `${stem}--before.png`),
                1000,
              ),
            });
            if (candidate!.sceneType === 'interactive') {
              let frame = await activeFrame(page, pageId);
              const { markers } = inspectAcceptanceScene(candidate!.scene, scenario);
              const primary = new Set(
                geometryAcceptancePrimaryMarkers(markers, scenario.scenarioId).map(
                  ({ instanceId }) => instanceId,
                ),
              );
              if (!markers.length) {
                try {
                  await interactCustom(page, frame, scenario, entry.observations);
                } catch (error) {
                  entry.observations.push({
                    kind: 'custom-automation-incomplete',
                    reason: String(error),
                    reviewRequired: true,
                  });
                }
                entry.status = 'review-required';
              }
              for (const { instanceId, envelope } of markers) {
                const root = frame.locator(`[data-geometry-instance="${instanceId}"]`);
                await root.waitFor();
                entry.observations.push({
                  kind: 'geometry-before',
                  instanceId,
                  image: await captureLocatorNonblank(
                    root.locator('.reach-geometry-scene'),
                    path.join(
                      prepared.outputDirectory,
                      `${stem}--${instanceId}--geometry-before.png`,
                    ),
                    1000,
                  ),
                });
                const initial = await computedState(frame, instanceId);
                if (primary.has(instanceId))
                  assertGeometryAcceptanceSnapshot(scenario.scenarioId, envelope, initial);
                else entry.status = 'review-required';
                const probes = geometryAcceptanceProbes(envelope);
                for (const probe of probes) {
                  await root.locator('[data-geometry-action="reset"]').click();
                  const input = root.locator(`[data-geometry-input="${probe.field}"]`);
                  requireCondition(
                    (await input.count()) === 1,
                    `No actual control for ${probe.field}`,
                  );
                  await changeNumber(input, probe.value);
                  const observed = await computedState(frame, instanceId);
                  assertAcceptanceInputChanged(observed, probe.field, probe.value);
                  if (primary.has(instanceId))
                    assertGeometryAcceptanceSnapshot(scenario.scenarioId, envelope, observed);
                  entry.observations.push({
                    kind: 'input',
                    instanceId,
                    field: probe.field,
                    value: probe.value,
                    snapshot: observed,
                  });
                }
                if (primary.has(instanceId))
                  await dragFreedoms(
                    page,
                    frame,
                    instanceId,
                    envelope,
                    scenario,
                    profile.name.startsWith('mobile'),
                    entry.observations,
                  );
                entry.observations.push({
                  kind: 'geometry-after',
                  instanceId,
                  image: await captureLocatorNonblank(
                    root.locator('.reach-geometry-scene'),
                    path.join(
                      prepared.outputDirectory,
                      `${stem}--${instanceId}--geometry-after.png`,
                    ),
                    1000,
                  ),
                });
                // The remount assertion below is the authoritative persistence check. The
                // bridge coalesces stateChange events, so inspecting a parent snapshot before
                // remount can race the final event and report a false failure.
                const beforeView = await computedState(frame, instanceId);
                const rotate = root.locator('[data-geometry-action="rotateRight"]');
                if (await rotate.count()) {
                  await rotate.click();
                  const afterView = await computedState(frame, instanceId);
                  requireCondition(
                    JSON.stringify(beforeView.objects) === JSON.stringify(afterView.objects) &&
                      JSON.stringify(beforeView.measurements) ===
                        JSON.stringify(afterView.measurements),
                    'Camera changed geometry or measurements',
                  );
                }
                const previousNonce = await page
                  .locator(`iframe[data-scene-id="${pageId}"]`)
                  .getAttribute('data-bridge-nonce');
                await page.evaluate(() =>
                  (
                    window as unknown as { __REACH_DECK_HARNESS_REMOUNT__(): void }
                  ).__REACH_DECK_HARNESS_REMOUNT__(),
                );
                await page.waitForFunction(
                  ({ id, previous }) =>
                    document.querySelector<HTMLIFrameElement>(`iframe[data-scene-id="${id}"]`)
                      ?.dataset.bridgeNonce !== previous,
                  { id: pageId, previous: previousNonce },
                );
                frame = await activeFrame(page, pageId);
                const restored = await computedState(frame, instanceId);
                requireCondition(
                  JSON.stringify(restored.inputs) === JSON.stringify(beforeView.inputs),
                  `Learner inputs were lost on Player remount: expected ${JSON.stringify(beforeView.inputs)}, observed ${JSON.stringify(restored.inputs)}`,
                );
                entry.observations.push({ kind: 'restore', instanceId, inputs: restored.inputs });
              }
              entry.observations.push({ kind: 'layout', layout: await inspectLayout(frame) });
            } else {
              requireCondition(
                candidate!.sceneType === 'slide' &&
                  prepared.document.nativeSlides.some((binding) => binding.pageId === pageId),
                'Concept control did not reach native Slide Player',
              );
              entry.status = 'review-required';
              entry.observations.push({
                kind: 'concept-copy',
                text: (await page.locator('[data-harness-player]').innerText()).slice(0, 12000),
              });
            }
            entry.observations.push({
              kind: 'after',
              image: await captureLocatorNonblank(
                page.locator('[data-harness-player]'),
                path.join(prepared.outputDirectory, `${stem}--after.png`),
                1000,
              ),
            });
            const harnessPointerCaptureErrors = errors.filter((error) =>
              /setPointerCapture.*InvalidStateError/i.test(error),
            );
            if (harnessPointerCaptureErrors.length) {
              entry.status = 'review-required';
              entry.observations.push({
                kind: 'harness-pointer-capture-race',
                errors: harnessPointerCaptureErrors,
                reviewRequired: true,
              });
            }
            const materialErrors = errors.filter(
              (error) => !/setPointerCapture.*InvalidStateError/i.test(error),
            );
            requireCondition(materialErrors.length === 0, materialErrors.join('\n'));
          } catch (error) {
            entry.status = 'failed';
            entry.error = error instanceof Error ? error.message : String(error);
            await page
              .screenshot({
                path: path.join(
                  prepared.outputDirectory,
                  `${pageId}--${profile.name}--failure.png`,
                ),
              })
              .catch(() => undefined);
          } finally {
            await page.close();
            await writeFile(
              path.join(prepared.outputDirectory, 'geometry-acceptance-browser.json'),
              `${JSON.stringify(evidence, null, 2)}\n`,
              'utf8',
            );
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return evidence;
}
