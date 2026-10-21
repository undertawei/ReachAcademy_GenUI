import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Frame, type Locator, type Page } from 'playwright-core';
import { PerspectiveCamera, Vector3 } from 'three';
import type {
  GeometryComputedState,
  GeometrySessionCommand,
  GeometrySessionState,
} from '@reachany/reach-deck-geometry/session';
import type { PreparedPlayerHarness } from './player-harness.js';

interface GeometryApi {
  getState(id: string): GeometrySessionState;
  getComputedState(id: string): GeometryComputedState;
  applyCommand(id: string, command: unknown): { ok: boolean; code?: string };
  setState(id: string, state: unknown): boolean;
}
interface Evidence {
  profile: string;
  check: string;
  detail: unknown;
}
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const closeTo = (actual: number | null | undefined, expected: number, message: string): void =>
  requireCondition(
    typeof actual === 'number' && Math.abs(actual - expected) < 1e-7,
    `${message}: ${actual} != ${expected}`,
  );
const state = (frame: Frame, id = 'geometry-1') =>
  frame.evaluate(
    (id) =>
      (window as unknown as { ReachScienceKits: GeometryApi }).ReachScienceKits.getComputedState(
        id,
      ),
    id,
  );
const apply = async (
  frame: Frame,
  command: GeometrySessionCommand,
  id = 'geometry-1',
): Promise<void> => {
  const result = await frame.evaluate(
    ({ id, command }) =>
      (window as unknown as { ReachScienceKits: GeometryApi }).ReachScienceKits.applyCommand(id, {
        schemaVersion: 'reach-geometry-command/v1',
        ...command,
      }),
    { id, command },
  );
  requireCondition(result.ok, `Command failed: ${JSON.stringify(command)}: ${result.code}`);
  await frame.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
};

async function activeFrame(page: Page, pageId: string): Promise<Frame> {
  const locator = page.locator(`iframe[data-scene-id="${pageId}"][data-visible="true"]`);
  await locator.waitFor({ state: 'visible' });
  await page.waitForFunction(
    (id) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        `iframe[data-scene-id="${id}"][data-visible="true"]`,
      );
      if (frame?.dataset.bridgePhase === 'failed')
        throw new Error(`Geometry iframe failed: ${frame.dataset.errorCode}`);
      return frame?.dataset.bridgePhase === 'active';
    },
    pageId,
    { timeout: 20_000 },
  );
  const frame = await (await locator.elementHandle())!.contentFrame();
  requireCondition(frame, 'Missing geometry iframe');
  await frame.locator('[data-geometry-instance]').first().waitFor();
  return frame;
}
async function openCase(page: Page, name: string): Promise<Frame> {
  const id = `geometry-${name}`;
  await page.locator('[data-harness-page-select]').selectOption(id);
  return activeFrame(page, id);
}

async function capture(page: Page, locator: Locator, filename: string): Promise<unknown> {
  const bytes = await locator.screenshot({ path: filename });
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minimum = 255,
      maximum = 0,
      colored = 0;
    for (let index = 0; index < rgba.length; index += 4) {
      minimum = Math.min(minimum, rgba[index]!, rgba[index + 1]!, rgba[index + 2]!);
      maximum = Math.max(maximum, rgba[index]!, rgba[index + 1]!, rgba[index + 2]!);
      if (
        Math.max(rgba[index]!, rgba[index + 1]!, rgba[index + 2]!) -
          Math.min(rgba[index]!, rgba[index + 1]!, rgba[index + 2]!) >
        25
      )
        colored++;
    }
    return { width: image.width, height: image.height, spread: maximum - minimum, colored };
  }, bytes.toString('base64'));
  requireCondition(
    pixels.spread > 30 && pixels.colored > 30,
    `Blank geometry scene ${filename}: ${JSON.stringify(pixels)}`,
  );
  return {
    ...pixels,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function dragPlanar(page: Page, frame: Frame, touch: boolean): Promise<void> {
  const point = frame.locator('[data-reach-geometry-object="Q"]');
  await point.scrollIntoViewIfNeeded();
  const box = await point.boundingBox();
  requireCondition(box, 'Q has no rendered hit target');
  const before = await state(frame);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  if (touch) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + 24, y: y + 18, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await client.detach();
    }
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 35, y + 24, { steps: 5 });
    await page.mouse.up();
  }
  await frame.waitForFunction(
    (revision) =>
      (window as unknown as { ReachScienceKits: GeometryApi }).ReachScienceKits.getComputedState(
        'geometry-1',
      ).geometryRevision > revision,
    before.geometryRevision,
  );
  const after = await state(frame);
  requireCondition(after.selection === 'Q', 'Point dragging did not select Q');
  requireCondition(
    JSON.stringify(after.camera) === JSON.stringify(before.camera),
    'Point drag changed camera',
  );
  closeTo(after.measurements.radius?.value, 2, 'Circle constraint after drag');
}

async function numericControl(frame: Frame, key: string, value: string): Promise<void> {
  const input = frame.locator(`[data-geometry-input="${key}"]`);
  await input.fill(value);
  await input.press('Tab');
  await frame.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function pointerDrag(
  page: Page,
  point: { x: number; y: number },
  dx: number,
  dy: number,
): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 8 });
  await page.mouse.up();
}
async function planarEdgePoint(
  frame: Frame,
  id: string,
  fraction: number,
): Promise<{ x: number; y: number }> {
  const line = frame.locator(`[data-reach-geometry-object="${id}"]`);
  await line.scrollIntoViewIfNeeded();
  const point = await line.evaluate((element, fraction) => {
    const shape = element as SVGGeometryElement;
    const point = shape.getPointAtLength(shape.getTotalLength() * fraction);
    const transformed = new DOMPoint(point.x, point.y).matrixTransform(shape.getScreenCTM()!);
    return { x: transformed.x, y: transformed.y };
  }, fraction);
  const bounds = await (await frame.frameElement()).boundingBox();
  requireCondition(bounds, 'Missing frame bounds');
  return { x: bounds.x + point.x, y: bounds.y + point.y };
}
async function spatialPoint(
  frame: Frame,
  coordinates: readonly number[],
): Promise<{ x: number; y: number }> {
  const current = await state(frame);
  requireCondition(
    current.camera.kind === 'spatial' && current.camera.projection === 'perspective',
    'Spatial pointer probe requires perspective camera',
  );
  const canvas = frame.locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  requireCondition(box, 'Missing spatial canvas');
  const spec = current.camera;
  const camera = new PerspectiveCamera(42, box.width / box.height, 0.001, 10000);
  camera.position.fromArray(spec.position);
  camera.up.fromArray(spec.up);
  camera.lookAt(new Vector3().fromArray(spec.target));
  camera.zoom = spec.zoom;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const projected = new Vector3().fromArray(coordinates).project(camera);
  return {
    x: box.x + ((projected.x + 1) * box.width) / 2,
    y: box.y + ((1 - projected.y) * box.height) / 2,
  };
}

async function layoutEvidence(
  frame: Frame,
  primaryIds = ['A', 'B', 'C', 'D', 'P'],
): Promise<unknown> {
  const result = await frame.evaluate((primaryIds) => {
    const scene = document.querySelector<HTMLElement>('.reach-geometry-scene')!;
    const bounds = scene.getBoundingClientRect();
    const labels = [
      ...scene.querySelectorAll<HTMLElement>('[data-geometry-label],[data-reach-geometry-label]'),
    ]
      .map((label) => {
        const box = label.getBoundingClientRect();
        return {
          id: label.dataset.geometryLabel ?? label.dataset.reachGeometryLabel,
          x: box.x - bounds.x,
          y: box.y - bounds.y,
          width: box.width,
          height: box.height,
        };
      })
      .filter((label) => label.width > 0 && label.height > 0);
    const overlaps: string[] = [];
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i]!,
          b = labels[j]!;
        if (
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2
        )
          overlaps.push(`${a.id}/${b.id}`);
      }
    const points = [
      ...scene.querySelectorAll<SVGGraphicsElement>(
        '[data-reach-geometry-object="A"],[data-reach-geometry-object="B"],[data-reach-geometry-object="Q"]',
      ),
    ].map((point) => {
      const box = point.getBoundingClientRect();
      return { x: box.x + box.width / 2 - bounds.x, y: box.y + box.height / 2 - bounds.y };
    });
    const anchors = points.length
      ? points
      : labels
          .filter((label) => primaryIds.includes(label.id ?? ''))
          .map((label) => ({ x: label.x, y: label.y }));
    const occupancy = anchors.length
      ? {
          width:
            Math.max(...anchors.map((point) => point.x)) -
            Math.min(...anchors.map((point) => point.x)),
          height:
            Math.max(...anchors.map((point) => point.y)) -
            Math.min(...anchors.map((point) => point.y)),
        }
      : null;
    return {
      width: bounds.width,
      height: bounds.height,
      labels,
      overlaps,
      occupancy,
      horizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, primaryIds);
  requireCondition(
    result.width >= 250 && result.height >= 240,
    `Collapsed geometry scene: ${JSON.stringify(result)}`,
  );
  requireCondition(result.horizontalOverflow <= 2, 'Geometry iframe has horizontal overflow');
  requireCondition(
    result.overlaps.length === 0,
    `Geometry label collisions: ${result.overlaps.join(', ')}`,
  );
  requireCondition(
    result.occupancy &&
      Math.min(result.occupancy.width, result.occupancy.height) >=
        Math.min(result.width, result.height) * 0.2,
    `Primary construction is too small: ${JSON.stringify(result.occupancy)}`,
  );
  return result;
}

async function performanceProbe(frame: Frame, count: number): Promise<unknown> {
  const evidence = await frame.evaluate(async () => {
    const api = (window as unknown as { ReachScienceKits: GeometryApi }).ReachScienceKits;
    const durations: number[] = [];
    for (let index = 0; index < 24; index++) {
      const started = performance.now();
      const result = api.applyCommand('geometry-1', {
        schemaVersion: 'reach-geometry-command/v1',
        kind: 'setParameter',
        id: 'theta',
        value: (index % 12) / 12,
      });
      if (!result.ok) throw new Error('Performance input rejected');
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      // Reading SVG bounds after the scheduled render includes layout in visible latency.
      document.querySelector('.reach-geometry-scene svg')?.getBoundingClientRect();
      durations.push(performance.now() - started);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      objects: Object.keys(api.getComputedState('geometry-1').objects).length,
      measurements: Object.keys(api.getComputedState('geometry-1').measurements).length,
      durations,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      maximum: sorted.at(-1)!,
    };
  });
  requireCondition(evidence.objects === count, `Expected ${count} objects`);
  requireCondition(evidence.measurements === 8, 'Expected 8 measurements');
  requireCondition(
    count === 40 ? evidence.p95 <= 50 : evidence.maximum <= 200,
    `Input-to-visible budget failed: ${JSON.stringify(evidence)}`,
  );
  return evidence;
}

async function desktopCases(
  page: Page,
  evidence: Evidence[],
  outputDirectory: string,
): Promise<void> {
  for (const angle of [30, 90, 120, 180]) {
    const frame = await openCase(page, `dihedral-${angle}`);
    closeTo((await state(frame)).measurements.angleValue?.value, angle, 'Dihedral');
    evidence.push({
      profile: 'desktop',
      check: `dihedral-${angle}-initial-layout`,
      detail: await layoutEvidence(frame, ['A', 'B', 'Q1', 'Q2']),
    });
    evidence.push({
      profile: 'desktop',
      check: `dihedral-${angle}-initial-render`,
      detail: await capture(
        page,
        frame.locator('canvas'),
        path.join(outputDirectory, `desktop-dihedral-${angle}.png`),
      ),
    });
    const before = await state(frame);
    await frame.locator('[data-geometry-action="rotateLeft"]').click();
    const after = await state(frame);
    requireCondition(
      JSON.stringify(before.measurements) === JSON.stringify(after.measurements),
      'Orbit changed dihedral measurement',
    );
    requireCondition(
      after.geometryRevision === before.geometryRevision,
      'Orbit changed geometry revision',
    );
    evidence.push({ profile: 'desktop', check: `dihedral-${angle}`, detail: after.measurements });
  }
  const translated = await openCase(page, 'translation');
  const beforeTranslation = await state(translated);
  await pointerDrag(page, await planarEdgePoint(translated, 'Edge', 0.75), 50, -35);
  await translated.waitForFunction(
    (revision) =>
      (window as unknown as { ReachScienceKits: GeometryApi }).ReachScienceKits.getComputedState(
        'geometry-1',
      ).geometryRevision > revision,
    beforeTranslation.geometryRevision,
  );
  closeTo((await state(translated)).measurements.length?.value, 3, 'Translated edge length');
  const beforeDependent = await state(translated);
  await pointerDrag(page, await planarEdgePoint(translated, 'DependentEdge', 0.5), 35, 25);
  const afterDependent = await state(translated);
  requireCondition(
    (await state(translated)).selection === 'DependentEdge',
    'Dependent edge selection',
  );
  requireCondition(
    JSON.stringify(afterDependent.inputs) === JSON.stringify(beforeDependent.inputs) &&
      JSON.stringify(afterDependent.camera) === JSON.stringify(beforeDependent.camera),
    'Dependent edge detached or orbited',
  );
  evidence.push({
    profile: 'desktop',
    check: 'G5-real-edge-drag',
    detail: await capture(
      page,
      translated.locator('.reach-geometry-scene'),
      path.join(outputDirectory, 'desktop-translation.png'),
    ),
  });
  const recovery = await openCase(page, 'recovery');
  await numericControl(recovery, 'parameter:height', '2');
  requireCondition(
    (await state(recovery)).objects.Lower?.status === 'undefined',
    'Intersection must become undefined',
  );
  await page
    .locator('[data-harness-player]')
    .screenshot({ path: path.join(outputDirectory, 'desktop-degenerate.png') });
  await numericControl(recovery, 'parameter:height', '0');
  closeTo((await state(recovery)).measurements.separation?.value, 2, 'Intersection recovery');
  evidence.push({
    profile: 'desktop',
    check: 'G6-recovered-render',
    detail: await capture(
      page,
      recovery.locator('.reach-geometry-scene'),
      path.join(outputDirectory, 'desktop-recovered.png'),
    ),
  });
  const transforms = await openCase(page, 'transforms');
  const transformed = await state(transforms);
  evidence.push({
    profile: 'desktop',
    check: 'G8-initial-layout',
    detail: await layoutEvidence(transforms, [
      'A',
      'B',
      'P',
      'RotationB',
      'ScaleB',
      'MirrorP',
      'ScaleP',
    ]),
  });
  closeTo(transformed.measurements.rotatedLength?.value, 4, 'Rotated edge invariant');
  closeTo(transformed.measurements.scaledLength?.value, 8, 'Scaled edge ratio');
  closeTo(transformed.objects.MirrorP?.coordinates?.[2], -4, 'Mirror reverses spatial orientation');
  closeTo(transformed.objects.RotationB?.coordinates?.[0], 4 * Math.cos(0.5), 'Entity rotation X');
  closeTo(transformed.objects.RotationB?.coordinates?.[1], 4 * Math.sin(0.5), 'Entity rotation Y');
  evidence.push({
    profile: 'desktop',
    check: 'G8-transformed-render',
    detail: await capture(
      page,
      transforms.locator('canvas'),
      path.join(outputDirectory, 'desktop-transforms.png'),
    ),
  });
  evidence.push({
    profile: 'desktop',
    check: 'G5-G6-G8',
    detail: {
      translation: 'length preserved',
      recovery: 'undefined and recovered',
      transforms: transformed.measurements,
    },
  });

  const instances = await openCase(page, 'instances');
  await apply(instances, { kind: 'setParameter', id: 'theta', value: 1 }, 'geometry-1');
  closeTo(
    (await state(instances, 'geometry-2')).inputs.parameters.theta,
    0,
    'Independent instance',
  );
  const reject = await instances.evaluate(() => {
    const api = (window as unknown as { ReachScienceKits: GeometryApi }).ReachScienceKits;
    const own = api.getState('geometry-1');
    const before = JSON.stringify(api.getComputedState('geometry-1'));
    const fixed = api.setState('geometry-1', {
      ...own,
      inputs: { ...own.inputs, parameters: { ...own.inputs.parameters, fixed: 1 } },
    });
    const cross = api.setState('geometry-2', own);
    const version = api.setState('geometry-1', {
      ...own,
      schemaVersion: 'reach-geometry-state/v2',
    });
    return {
      fixed,
      cross,
      version,
      unchanged: before === JSON.stringify(api.getComputedState('geometry-1')),
    };
  });
  requireCondition(
    !reject.fixed && !reject.cross && !reject.version && reject.unchanged,
    'Tampered/cross-instance snapshots were accepted',
  );
  await page.waitForFunction(() =>
    Boolean(
      (
        window as unknown as {
          __REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__: Record<string, { snapshot?: unknown }>;
        }
      ).__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__['geometry-instances']?.snapshot,
    ),
  );
  await page.evaluate(() =>
    (
      window as unknown as { __REACH_DECK_HARNESS_REMOUNT__: () => void }
    ).__REACH_DECK_HARNESS_REMOUNT__(),
  );
  const restored = await activeFrame(page, 'geometry-instances');
  closeTo((await state(restored)).inputs.parameters.theta, 1, 'Player remount snapshot');
  requireCondition(
    (await page
      .locator('iframe[data-scene-id="geometry-instances"]')
      .getAttribute('data-bridge-restored')) === 'true',
    'Player did not acknowledge restored token',
  );
  requireCondition(
    (await restored.evaluate(
      () =>
        (window as unknown as { __GEOMETRY_HARNESS_EVENTS__: unknown[] })
          .__GEOMETRY_HARNESS_EVENTS__.length,
    )) === 0,
    'Restore emitted a geometry learner action',
  );
  requireCondition(
    await page.evaluate(
      () =>
        !Object.values(
          (
            window as unknown as {
              __REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__: Record<string, { completed?: boolean }>;
            }
          ).__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__,
        ).some((runtime) => runtime.completed),
    ),
    'Geometry generated completion',
  );
  await restored
    .locator('[data-geometry-instance="geometry-1"] [data-geometry-action="reset"]')
    .click();
  closeTo((await state(restored)).inputs.parameters.theta, 0, 'Reset initial state');
  evidence.push({ profile: 'desktop', check: 'G7-state-isolation-restore-reset', detail: reject });
  const irregular = await openCase(page, 'irregular');
  const irregularBefore = await state(irregular);
  await irregular.locator('[data-geometry-action="rotateLeft"]').click();
  requireCondition(
    JSON.stringify((await state(irregular)).measurements) ===
      JSON.stringify(irregularBefore.measurements),
    'Irregular tetrahedron camera changed geometry',
  );
  evidence.push({
    profile: 'desktop',
    check: 'irregular-tetrahedron',
    detail: await capture(
      page,
      irregular.locator('canvas'),
      path.join(outputDirectory, 'desktop-irregular.png'),
    ),
  });
}

export async function runGeometryPlayerSmoke(
  prepared: PreparedPlayerHarness,
  origin: string,
): Promise<void> {
  const browser = await chromium.launch();
  const evidence: Evidence[] = [];
  const profiles = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'landscape', width: 844, height: 390 },
  ];
  let failure: string | undefined;
  try {
    for (const profile of profiles) {
      const mobile = profile.name === 'mobile' || profile.name === 'landscape';
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        isMobile: mobile,
        hasTouch: mobile,
        deviceScaleFactor: 1,
      });
      try {
        const page = await context.newPage();
        const client = await context.newCDPSession(page);
        await client.send('Network.enable');
        await client.send('Network.clearBrowserCache');
        await client.send('Network.setCacheDisabled', { cacheDisabled: true });
        const resources: { url: string; bytes: number; status: number }[] = [];
        const pending: Promise<void>[] = [];
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', (response) => {
          if (response.url().includes('/reach-deck-dependencies/'))
            pending.push(
              response.body().then((bytes) => {
                resources.push({
                  url: new URL(response.url()).pathname,
                  bytes: bytes.length,
                  status: response.status(),
                });
              }),
            );
        });
        await page.goto(origin);
        let planar = await activeFrame(page, 'geometry-planar');
        requireCondition(
          await planar.evaluate(() => !('JXG' in window) && !('THREE' in window)),
          'Raw geometry globals exposed',
        );
        await dragPlanar(page, planar, mobile);
        await numericControl(planar, 'freedom:dragQ:y', '5');
        closeTo(
          (await state(planar)).measurements.height?.value,
          5,
          'Keyboard numeric alternative',
        );
        const saved = await state(planar);
        await page.locator('[data-harness-locale]').selectOption('zh-CN');
        await page.waitForFunction(
          () =>
            document
              .querySelector('iframe[data-visible="true"]')
              ?.getAttribute('data-bridge-phase') === 'active',
        );
        planar = await activeFrame(page, 'geometry-planar');
        await planar.locator('[data-geometry-action="reset"][aria-label="重置"]').waitFor();
        closeTo(
          (await state(planar)).measurements.height?.value,
          saved.measurements.height!.value!,
          'Locale flush preserves latest state',
        );
        await planar.locator('[data-geometry-group="auxiliary"]').uncheck();
        requireCondition(
          !(await state(planar)).visibleGroups.includes('auxiliary'),
          'Group toggle',
        );
        await planar.locator('[data-geometry-group="auxiliary"]').check();
        evidence.push({
          profile: profile.name,
          check: 'planar-render',
          detail: await capture(
            page,
            planar.locator('.reach-geometry-scene'),
            path.join(prepared.outputDirectory, `${profile.name}-planar.png`),
          ),
        });
        evidence.push({
          profile: profile.name,
          check: 'planar-layout',
          detail: await layoutEvidence(planar),
        });
        const spatial = await openCase(page, 'pyramid');
        await spatial.locator('[data-geometry-selection]').selectOption('PBC');
        requireCondition((await state(spatial)).selection === 'PBC', 'Face selection');
        await numericControl(spatial, 'parameter:h', '5');
        closeTo(
          (await state(spatial)).measurements.height?.value,
          5,
          'Constrained spatial line control',
        );
        await numericControl(spatial, 'freedom:dragOnPlane:u', '0.5');
        const beforeOrbit = await state(spatial);
        await spatial.locator('[data-geometry-action="rotateRight"]').click();
        const afterOrbit = await state(spatial);
        requireCondition(
          JSON.stringify(afterOrbit.measurements) === JSON.stringify(beforeOrbit.measurements),
          'Camera changed mathematical measurements',
        );
        evidence.push({
          profile: profile.name,
          check: 'spatial-canvas-pixels',
          detail: await capture(
            page,
            spatial.locator('canvas'),
            path.join(prepared.outputDirectory, `${profile.name}-spatial.png`),
          ),
        });
        evidence.push({
          profile: profile.name,
          check: 'spatial-layout',
          detail: await layoutEvidence(spatial),
        });
        await page
          .locator('[data-harness-player]')
          .screenshot({ path: path.join(prepared.outputDirectory, `${profile.name}-player.png`) });
        await Promise.all(pending);
        const total = [
          ...new Map(resources.map((resource) => [resource.url, resource])).values(),
        ].reduce((sum, resource) => sum + resource.bytes, 0);
        requireCondition(
          resources.some((resource) => resource.url.includes('geometry-euclidean-2d')) &&
            resources.some((resource) => resource.url.includes('geometry-euclidean-3d')) &&
            total > 0,
          'Cold runtime accounting did not observe both geometry bundles',
        );
        requireCondition(
          resources.every((resource) => resource.status === 200),
          'Cold runtime request failed',
        );
        requireCondition(total <= 5 * 1024 * 1024, `Cold runtime bytes exceeded: ${total}`);
        evidence.push({
          profile: profile.name,
          check: 'cold-runtime-requests',
          detail: { resources, uniqueBytes: total, cacheDisabled: true, physicalDevice: false },
        });
        if (profile.name === 'desktop') {
          const camera = (await state(spatial)).camera;
          requireCondition(camera.kind === 'spatial', 'Expected spatial camera');
          await apply(spatial, {
            kind: 'setCamera',
            camera: { ...camera, projection: 'perspective' },
          });
          const beforePoint = await state(spatial);
          await pointerDrag(
            page,
            await spatialPoint(spatial, beforePoint.objects.P!.coordinates!),
            0,
            -25,
          );
          await spatial.waitForFunction(
            (revision) =>
              (
                window as unknown as { ReachScienceKits: GeometryApi }
              ).ReachScienceKits.getComputedState('geometry-1').geometryRevision > revision,
            beforePoint.geometryRevision,
          );
          const afterPoint = await state(spatial);
          closeTo(afterPoint.objects.P!.coordinates![0], 0, 'Spatial line drag X');
          closeTo(afterPoint.objects.P!.coordinates![1], 0, 'Spatial line drag Y');
          const beforePlane = await state(spatial);
          await pointerDrag(
            page,
            await spatialPoint(spatial, beforePlane.objects.OnPlane!.coordinates!),
            22,
            16,
          );
          await spatial.waitForFunction(
            (revision) =>
              (
                window as unknown as { ReachScienceKits: GeometryApi }
              ).ReachScienceKits.getComputedState('geometry-1').geometryRevision > revision,
            beforePlane.geometryRevision,
          );
          const afterPlane = await state(spatial);
          closeTo(
            afterPlane.objects.OnPlane!.coordinates![2],
            0,
            'Oblique-plane constrained drag Z',
          );
          requireCondition(
            JSON.stringify(afterPlane.camera) === JSON.stringify(beforePlane.camera),
            'Constrained plane drag orbited camera',
          );
          const p = afterPlane.objects.P!.coordinates!,
            b = afterPlane.objects.B!.coordinates!,
            c = afterPlane.objects.C!.coordinates!;
          const facePoint = p.map((value, i) => value * 0.4 + b[i]! * 0.25 + c[i]! * 0.35);
          await page.mouse.click(
            ...(Object.values(await spatialPoint(spatial, facePoint)) as [number, number]),
          );
          requireCondition(
            (await state(spatial)).selection === 'PBC',
            'Spatial face hit did not select PBC',
          );
          const surface = await spatial.locator('canvas').boundingBox();
          requireCondition(surface, 'Missing canvas bounds');
          const beforeEmpty = await state(spatial);
          await pointerDrag(page, { x: surface.x + 12, y: surface.y + 12 }, 24, 16);
          const afterEmpty = await state(spatial);
          requireCondition(
            JSON.stringify(afterEmpty.camera) !== JSON.stringify(beforeEmpty.camera) &&
              afterEmpty.geometryRevision === beforeEmpty.geometryRevision,
            'Empty scene did not orbit independently',
          );
          evidence.push({
            profile: 'desktop',
            check: 'spatial-ray-constrained-drags-face-and-empty-orbit',
            detail: {
              beforeLine: beforePoint.inputs,
              afterLine: afterPoint.inputs,
              beforePlane: beforePlane.inputs,
              afterPlane: afterPlane.inputs,
            },
          });
          await desktopCases(page, evidence, prepared.outputDirectory);
        }
        if (profile.name === 'mobile') {
          const dihedral = await openCase(page, 'dihedral-120');
          evidence.push({
            profile: profile.name,
            check: 'dihedral-120-initial-layout',
            detail: await layoutEvidence(dihedral, ['A', 'B', 'Q1', 'Q2']),
          });
          evidence.push({
            profile: profile.name,
            check: 'dihedral-120-initial-render',
            detail: await capture(
              page,
              dihedral.locator('canvas'),
              path.join(prepared.outputDirectory, 'mobile-dihedral-120.png'),
            ),
          });
        }
        if (profile.name === 'desktop' || profile.name === 'mobile')
          for (const count of [40, 128])
            evidence.push({
              profile: profile.name,
              check: `performance-${count}`,
              detail: await performanceProbe(await openCase(page, `performance-${count}`), count),
            });
        requireCondition(errors.length === 0, `Browser exceptions: ${errors.join('; ')}`);
        await client.detach();
      } finally {
        await context.close();
      }
    }
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => {
        const native = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          kind: string,
          ...args: unknown[]
        ) {
          if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
          return Reflect.apply(native, this, [kind, ...args]);
        } as typeof native;
      });
      const page = await context.newPage();
      await page.goto(origin);
      await activeFrame(page, 'geometry-planar');
      await page.locator('[data-harness-page-select]').selectOption('geometry-pyramid');
      await page.locator('[role="alert"]').first().waitFor();
      const iframe = page.locator('iframe[data-scene-id="geometry-pyramid"]');
      requireCondition(
        (await iframe.getAttribute('data-bridge-phase')) === 'failed',
        'WebGL failure incorrectly reported ready',
      );
      requireCondition(
        (await page.getByRole('button', { name: 'Retry activity' }).count()) === 1,
        'Missing renderer failure retry',
      );
      await page
        .locator('[data-harness-player]')
        .screenshot({ path: path.join(prepared.outputDirectory, 'desktop-webgl-unavailable.png') });
      evidence.push({
        profile: 'desktop',
        check: 'webgl-unavailable',
        detail: { phase: 'failed', retry: true },
      });
    } finally {
      await context.close();
    }
    const lossContext = await browser.newContext();
    try {
      const page = await lossContext.newPage();
      await page.goto(origin);
      await activeFrame(page, 'geometry-planar');
      const spatial = await openCase(page, 'pyramid');
      requireCondition(
        await spatial.evaluate(() => {
          const canvas = document.querySelector('canvas')!;
          const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
          const extension = gl?.getExtension('WEBGL_lose_context');
          if (!extension) return false;
          extension.loseContext();
          return true;
        }),
        'Chromium did not expose the context-loss test extension',
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('iframe[data-visible="true"]')
            ?.getAttribute('data-bridge-phase') === 'failed',
      );
      requireCondition(
        (await spatial.locator('[data-geometry-action="reset"]').count()) === 0,
        'Failed Player retained live geometry controls',
      );
      requireCondition(
        await spatial.evaluate(() => {
          const result = (
            window as unknown as { ReachScienceKits: GeometryApi }
          ).ReachScienceKits.getComputedState('geometry-1') as unknown as {
            ok?: boolean;
            code?: string;
          };
          return result.ok === false;
        }),
        'Disposed geometry instance still exposes computed state',
      );
      await page.getByRole('button', { name: 'Retry activity' }).click();
      const restarted = await activeFrame(page, 'geometry-pyramid');
      evidence.push({
        profile: 'desktop',
        check: 'webgl-context-loss-retry',
        detail: await capture(
          page,
          restarted.locator('canvas'),
          path.join(prepared.outputDirectory, 'desktop-context-recovered.png'),
        ),
      });
    } finally {
      await lossContext.close();
    }
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    await writeFile(
      path.join(prepared.outputDirectory, 'geometry-smoke-evidence.json'),
      `${JSON.stringify({ browser: browser.version(), hardware: { platform: os.platform(), architecture: os.arch(), cpu: os.cpus()[0]?.model }, profiles, evidence, ...(failure ? { failure } : {}), limitations: ['Chromium emulation, not physical Android', 'Harness locale toggle uses production catalogs; role cookies and publication are P4', 'Synthetic input latency, no real model generation'] }, null, 2)}\n`,
    );
    await browser.close();
  }
}
