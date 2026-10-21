import { describe, expect, it } from 'vitest';
import type {
  ReachDeckNativeSlideV2,
  ReachDeckScientificVisualElementV2,
} from '@reachany/reach-deck-dsl';

import {
  buildScientificVisualSrcDoc,
  projectScientificVisualFrame,
  SCIENTIFIC_VISUAL_ANCHOR_PRESENTATION_SECONDS,
  SCIENTIFIC_VISUAL_FALLBACK_DURATION_SECONDS,
} from '../src/scientificVisualBridge.js';
import { REACH_SCIENTIFIC_DEPENDENCIES } from '../src/scientificDependencyRegistry.generated.js';

const element = (): ReachDeckScientificVisualElementV2 => ({
  id: 'scientific-motion',
  type: 'scientificVisual',
  transform: { x: 0, y: 0, width: 640, height: 360 },
  zIndex: 1,
  ariaLabel: 'Motion visual',
  documentHtml:
    '<!doctype html><html><head></head><body><div id="root"></div><script>ReachScientificVisual.register(({root}) => ({present(frame){root.textContent=String(frame.currentTime)},resize(){},dispose(){}}));</script></body></html>',
  manifest: {
    schemaVersion: 'reach-scientific-visual-manifest/v2',
    hooksVersion: 'reach-scientific-visual-hooks/v1',
    anchors: [
      { id: 'launch', description: 'Launch' },
      { id: 'arrival', description: 'Arrival' },
    ],
    dependencies: [],
    resourceIds: [],
    ariaLabel: 'Motion visual',
    textAlternative: 'A body moves from launch to arrival.',
  },
});

const slide = (
  bindings?: NonNullable<ReachDeckNativeSlideV2['narration']>['scientificAnchorBindings'],
): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'slide-1',
  title: 'Motion',
  background: { kind: 'none' },
  elements: [element()],
  animations: [],
  ...(bindings === undefined ? {} : { narration: { scientificAnchorBindings: bindings } }),
});

describe('scientific visual bridge', () => {
  it('projects deterministic fallback anchors and accepts backward seek', () => {
    const frame = projectScientificVisualFrame({
      slide: slide(),
      element: element(),
      currentTime: 1.25,
      effectiveDuration: 4,
      playing: true,
    });
    expect(frame.effectiveDuration).toBe(4);
    expect(frame).toMatchObject({ currentTime: 1.25, absoluteTime: 1.25, time: 1.25 });
    expect(frame.anchors[0]).toEqual({ id: 'launch', state: 'active', progress: 0.625 });
    expect(
      projectScientificVisualFrame({ slide: slide(), element: element(), currentTime: 0 })
        .anchors[0]?.state,
    ).toBe('active');
    expect(
      projectScientificVisualFrame({
        slide: slide(),
        element: element(),
        currentTime: 99,
      }).anchors.at(-1)?.state,
    ).toBe('after');
  });

  it('forces reduced-motion and static frames to deterministic t=0', () => {
    expect(
      projectScientificVisualFrame({
        slide: slide(),
        element: element(),
        currentTime: 3,
        playing: true,
        reducedMotion: true,
        activeNarrationSegmentId: 'cue-3',
      }),
    ).toMatchObject({
      currentTime: 0,
      absoluteTime: 0,
      time: 0,
      playing: false,
      reducedMotion: true,
    });
    expect(
      projectScientificVisualFrame({
        slide: slide(),
        element: element(),
        currentTime: 3,
        playing: true,
        staticMode: true,
      }).currentTime,
    ).toBe(0);
  });

  it('uses narration timing as the trigger but gives scientific motion its own presentation window', () => {
    const timedSlide: ReachDeckNativeSlideV2 = {
      ...slide(),
      duration: 10,
      narration: {
        audioResourceId: 'narration-audio',
        segments: [{ text: 'Launch, then arrive.', start: 0, end: 10 }],
        scientificAnchorBindings: [
          {
            id: 'narration-anchor:scientific-motion:launch',
            elementId: 'scientific-motion',
            anchorId: 'launch',
            start: 1,
            end: 1.2,
          },
          {
            id: 'narration-anchor:scientific-motion:arrival',
            elementId: 'scientific-motion',
            anchorId: 'arrival',
            start: 6,
            end: 6.2,
          },
        ],
      },
    };
    const halfway = projectScientificVisualFrame({
      slide: timedSlide,
      element: element(),
      currentTime: 1 + SCIENTIFIC_VISUAL_ANCHOR_PRESENTATION_SECONDS / 2,
      effectiveDuration: 10,
    });
    expect(halfway.anchors[0]).toEqual({ id: 'launch', state: 'active', progress: 0.5 });
    const shortlyAfterTrigger = projectScientificVisualFrame({
      slide: timedSlide,
      element: element(),
      currentTime: 1.3,
      effectiveDuration: 10,
    }).anchors[0];
    expect(shortlyAfterTrigger).toMatchObject({ state: 'active' });
    expect(shortlyAfterTrigger?.progress).toBeCloseTo(0.12);
    expect(
      projectScientificVisualFrame({
        slide: timedSlide,
        element: element(),
        currentTime: 3.5,
        effectiveDuration: 10,
      }).anchors[0],
    ).toEqual({ id: 'launch', state: 'after', progress: 1 });
  });

  it('caps a scientific presentation window at the next narration trigger', () => {
    const timedSlide: ReachDeckNativeSlideV2 = {
      ...slide(),
      duration: 5,
      narration: {
        audioResourceId: 'narration-audio',
        segments: [{ text: 'Two close transitions.', start: 0, end: 5 }],
        scientificAnchorBindings: [
          {
            id: 'narration-anchor:scientific-motion:launch',
            elementId: 'scientific-motion',
            anchorId: 'launch',
            start: 1,
            end: 1.1,
          },
          {
            id: 'narration-anchor:scientific-motion:arrival',
            elementId: 'scientific-motion',
            anchorId: 'arrival',
            start: 2,
            end: 2.1,
          },
        ],
      },
    };
    expect(
      projectScientificVisualFrame({
        slide: timedSlide,
        element: element(),
        currentTime: 1.5,
        effectiveDuration: 5,
      }).anchors[0],
    ).toEqual({ id: 'launch', state: 'active', progress: 0.5 });
    expect(
      projectScientificVisualFrame({
        slide: timedSlide,
        element: element(),
        currentTime: 2,
        effectiveDuration: 5,
      }).anchors[0],
    ).toEqual({ id: 'launch', state: 'after', progress: 1 });
  });

  it('falls back as one complete schedule when bindings are partial or stale', () => {
    const stale = slide([
      {
        id: 'narration-anchor:scientific-motion:launch',
        elementId: 'scientific-motion',
        anchorId: 'launch',
        start: 0,
        end: 1,
      },
    ]);
    const frame = projectScientificVisualFrame({
      slide: stale,
      element: element(),
      currentTime: 5,
    });
    expect(frame.effectiveDuration).toBe(SCIENTIFIC_VISUAL_FALLBACK_DURATION_SECONDS);
    expect(frame.anchors[1]?.state).toBe('after');
  });

  it('assembles CSP and repository-only dependencies without arbitrary network access', async () => {
    const srcdoc = await buildScientificVisualSrcDoc({
      element: element(),
      nonce: 'nonce-1234567890123456',
      dependencyBaseUrl: 'https://student.example',
    });
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).not.toContain('sandbox="allow-scripts"');
    expect(srcdoc).not.toContain('https://example.test');
    expect(srcdoc).toContain('ReachScientificVisual.register');
  });

  it('loads function plots only through the declared SRI-pinned repository dependency', async () => {
    const withPlot = element();
    withPlot.documentHtml = `${withPlot.documentHtml}<script type="application/json" data-reach-function-plot="plot">${JSON.stringify(
      {
        schemaVersion: 'reach-function-plot/v1',
        ariaLabel: 'Linear function',
        viewport: { x: [-5, 5], y: [-5, 5] },
        axes: { grid: true },
        series: [{ id: 'line', expression: 'x', colorToken: 'accent' }],
        parameters: [],
        markers: [],
        intersections: [],
      },
    )}</script>`;
    await expect(
      buildScientificVisualSrcDoc({
        element: withPlot,
        nonce: 'nonce-1234567890123456',
        dependencyBaseUrl: 'https://student.example',
      }),
    ).rejects.toThrow(/approved function-plot dependency/i);

    withPlot.manifest.dependencies = [{ id: 'function-plot', version: '1.25.4' }];
    const srcdoc = await buildScientificVisualSrcDoc({
      element: withPlot,
      nonce: 'nonce-1234567890123456',
      dependencyBaseUrl: 'https://student.example',
    });
    const parsed = new DOMParser().parseFromString(srcdoc, 'text/html');
    const cspSources =
      parsed
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content')
        ?.match(/script-src ([^;]+)/)?.[1]
        ?.split(' ') ?? [];
    const functionPlotDependency = REACH_SCIENTIFIC_DEPENDENCIES[0]!;
    const dependencyUrl = `https://student.example${functionPlotDependency.scriptPath}`;
    expect(srcdoc).toContain('data-reach-scientific-dependency="function-plot@1.25.4"');
    expect(srcdoc).toContain(`integrity="${functionPlotDependency.integrity}"`);
    expect(cspSources).toContain(dependencyUrl);
    expect(cspSources).not.toContain('https://student.example');
    expect(srcdoc).toContain('data-reach-scientific-function-plot-install');
    expect(srcdoc).not.toContain('data-reach-scientific-function-plot-runtime');
  });
});
