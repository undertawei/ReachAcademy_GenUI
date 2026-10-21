import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { MAX_INTERACTIVE_SRCDOC_BYTES, buildInteractiveSrcDoc } from '../src/interactiveBridge';
import {
  REACH_FUNCTION_PLOT_RUNTIME_SHA256,
  REACH_FUNCTION_PLOT_RUNTIME_SOURCE,
} from '../src/reachFunctionPlotRuntime.generated';

const plotSpec = {
  schemaVersion: 'reach-function-plot/v1',
  ariaLabel: '二次函数与直线交点',
  viewport: { x: [-5, 5], y: [-5, 15] },
  axes: { grid: true, xLabel: 'x', yLabel: 'y' },
  series: [
    { id: 'quadratic', expression: 'a*x^2', colorToken: 'accent' },
    { id: 'line', expression: '2*x+3', colorToken: 'warning' },
  ],
  parameters: [{ id: 'a', label: '二次项系数', minimum: 0.5, maximum: 2, step: 0.1, initial: 1 }],
  markers: [{ id: 'vertex', seriesId: 'quadratic', x: 0, label: '顶点' }],
  intersections: [
    {
      id: 'cross',
      firstSeriesId: 'quadratic',
      secondSeriesId: 'line',
      x: 3,
      label: '交点',
    },
  ],
} as const;

const srcdoc = (marker: string, authorScript = '') =>
  buildInteractiveSrcDoc({
    documentHtml: `<!doctype html><html><head></head><body><div id="plot"></div>${marker}<script>${authorScript}</script></body></html>`,
    nonce: '1234567890123456',
    allowReset: true,
    eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
  });

describe('Interactive ReachFunctionPlot host runtime', () => {
  it('injects the pinned local runtime only for a validated JSON marker', () => {
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script>`;
    const source = srcdoc(marker, 'window.authorRan = true;');
    expect(source).toContain('data-reach-function-plot-runtime');
    expect(source).toContain('data-reach-function-plot-install');
    expect(source.indexOf(REACH_FUNCTION_PLOT_RUNTIME_SOURCE.slice(0, 60))).toBeLessThan(
      source.indexOf('window.authorRan = true'),
    );
    expect(new TextEncoder().encode(source).byteLength).toBeLessThan(MAX_INTERACTIVE_SRCDOC_BYTES);
    expect(REACH_FUNCTION_PLOT_RUNTIME_SOURCE.length).toBeLessThan(300 * 1024);
    expect(REACH_FUNCTION_PLOT_RUNTIME_SHA256).toMatch(/^[a-f0-9]{64}$/);

    const ordinary = srcdoc('');
    expect(ordinary).not.toContain('data-reach-function-plot-runtime');
  });

  it('rejects malformed, duplicate, or non-declarative plot markers', () => {
    expect(() =>
      srcdoc('<script type="application/json" data-reach-function-plot="main">{</script>'),
    ).toThrow(/valid JSON/);
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script>`;
    expect(() => srcdoc(marker + marker)).toThrow(/must be unique/);
    expect(() =>
      srcdoc(
        `<script type="application/json" data-reach-function-plot="main">${JSON.stringify({
          ...plotSpec,
          callback: 'alert(1)',
        })}</script>`,
      ),
    ).toThrow(/contain exactly schemaVersion/);
  });

  it('renders and updates through callback evaluation while dynamic Function is disabled', () => {
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script>`;
    const source = srcdoc(
      marker,
      `
window.Function = function () { throw new Error('dynamic Function is disabled by CSP'); };
const config = window.ReachFunctionPlot.config('main');
const controller = window.ReachFunctionPlot.mount(document.getElementById('plot'), config);
const markerBeforeUpdate = document.getElementById('plot').textContent.includes('交点');
window.plotResult = {
  initial: controller.getParameters(),
  updated: controller.setParameters({ a: 1.5 }),
  paths: document.querySelectorAll('#plot path.line').length,
  markerBeforeUpdate
};`,
    );
    const dom = new JSDOM(source, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'http://localhost/',
    });
    const result = (dom.window as unknown as { plotResult?: Record<string, unknown> }).plotResult;
    expect(result).toMatchObject({
      initial: { a: 1 },
      updated: { a: 1.5 },
      paths: 2,
      markerBeforeUpdate: true,
    });
    expect(dom.window.document.querySelector('#plot')?.getAttribute('role')).toBe('img');
    expect(dom.window.document.querySelector('#plot')?.getAttribute('aria-label')).toBe(
      '二次函数与直线交点',
    );
    dom.window.close();
  });

  it('renders v2 scatter and ordered data polyline series with Reach-owned styles', () => {
    const v2Spec = {
      schemaVersion: 'reach-function-plot/v2',
      ariaLabel: 'Synthetic scatter and ordered measurements',
      viewport: { x: [-5, 5], y: [-5, 5] },
      axes: { grid: true, xLabel: 'x', yLabel: 'y' },
      series: [
        {
          kind: 'points',
          id: 'samples',
          points: [
            { x: -2, y: 1 },
            { x: 0, y: 3 },
            { x: 2, y: 2 },
          ],
          render: 'scatter',
          colorToken: 'success',
        },
        {
          kind: 'points',
          id: 'measurements',
          points: [
            { x: 3, y: -1 },
            { x: 1, y: 2 },
            { x: -1, y: 0 },
          ],
          render: 'polyline',
          colorToken: 'warning',
        },
      ],
      parameters: [],
      markers: [],
      intersections: [],
    } as const;
    const marker = `<script type="application/json" data-reach-function-plot="data">${JSON.stringify(v2Spec)}</script>`;
    const source = srcdoc(
      marker,
      `
const plot = document.getElementById('plot');
const controller = window.ReachFunctionPlot.mount(plot, window.ReachFunctionPlot.config('data'));
const scatter = [...plot.querySelectorAll('circle.scatter')];
const polyline = plot.querySelector('path.line');
const horizontalCoordinates = (polyline.getAttribute('d').match(/[ML][^ML]+/g) || [])
  .map((command) => Number(command.slice(1).trim().split(/[ ,]+/)[0]));
window.v2PlotResult = {
  parameters: controller.getParameters(),
  scatterCount: scatter.length,
  scatterRadii: scatter.map((point) => point.getAttribute('r')),
  scatterOpacities: scatter.map((point) => point.getAttribute('opacity')),
  scatterStrokeWidths: scatter.map((point) => point.getAttribute('stroke-width')),
  polylineStrokeWidth: polyline.getAttribute('stroke-width'),
  polylineOpacity: polyline.getAttribute('opacity'),
  polylinePreservedOrder:
    horizontalCoordinates.length === 3 &&
    horizontalCoordinates[0] > horizontalCoordinates[1] &&
    horizontalCoordinates[1] > horizontalCoordinates[2]
};`,
    );
    const dom = new JSDOM(source, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'http://localhost/',
    });
    const result = (dom.window as unknown as { v2PlotResult?: Record<string, unknown> })
      .v2PlotResult;
    expect(result).toEqual({
      parameters: {},
      scatterCount: 3,
      scatterRadii: ['4', '4', '4'],
      scatterOpacities: ['0.86', '0.86', '0.86'],
      scatterStrokeWidths: ['1.5', '1.5', '1.5'],
      polylineStrokeWidth: '3',
      polylineOpacity: '0.92',
      polylinePreservedOrder: true,
    });
    expect(dom.window.document.querySelector('#plot')?.getAttribute('aria-label')).toBe(
      v2Spec.ariaLabel,
    );
    dom.window.close();
  });

  it('keeps one stable-size plot across parameter updates and only rerenders for real resize events', () => {
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script>`;
    const source = srcdoc(
      marker,
      `
const plot = document.getElementById('plot');
let layoutWidth = 720;
let layoutHeight = 420;
let measureFromLayout = false;
let measurementCount = 0;
plot.getBoundingClientRect = () => {
  measurementCount += 1;
  const svg = plot.querySelector('svg');
  const width = measureFromLayout || !svg ? layoutWidth : Number(svg.getAttribute('width')) + 8;
  const height = measureFromLayout || !svg ? layoutHeight : Number(svg.getAttribute('height')) + 6;
  return { x: 0, y: 0, top: 0, right: width, bottom: height, left: 0, width, height, toJSON() {} };
};
const config = window.ReachFunctionPlot.config('main');
const controller = window.ReachFunctionPlot.mount(plot, config);
const initialSvg = plot.querySelector('svg');
const initialCurve = plot.querySelector('path.line').getAttribute('d');
for (let index = 0; index < 30; index += 1) {
  controller.setParameters({ a: index % 2 === 0 ? 1.5 : 1 });
}
const updatedSvg = plot.querySelector('svg');
const updatedCurve = plot.querySelector('path.line').getAttribute('d');
const svgCountAfterUpdates = plot.querySelectorAll('svg').length;
const measurementsAfterUpdates = measurementCount;

layoutWidth = 900;
layoutHeight = 500;
measureFromLayout = true;
window.dispatchEvent(new CustomEvent('reach-interactive-resize', {
  detail: { width: 1024, height: 768 }
}));
measureFromLayout = false;
const resizedSvg = plot.querySelector('svg');
const measurementsAfterResize = measurementCount;
window.dispatchEvent(new CustomEvent('reach-interactive-resize', {
  detail: { width: 1024, height: 768 }
}));
const sameSizeSvg = plot.querySelector('svg');

controller.destroy();
const measurementsBeforeDestroyedResize = measurementCount;
window.dispatchEvent(new CustomEvent('reach-interactive-resize', {
  detail: { width: 1200, height: 800 }
}));
window.plotStabilityResult = {
  initialWidth: initialSvg.getAttribute('width'),
  initialHeight: initialSvg.getAttribute('height'),
  updatedWidth: updatedSvg.getAttribute('width'),
  updatedHeight: updatedSvg.getAttribute('height'),
  initialCurve,
  updatedCurve,
  svgCountAfterUpdates,
  measurementsAfterUpdates,
  resizedWidth: resizedSvg.getAttribute('width'),
  resizedHeight: resizedSvg.getAttribute('height'),
  resizeWasRerendered: resizedSvg !== updatedSvg,
  sameSizeWasNoop: sameSizeSvg === resizedSvg,
  resizeMeasured: measurementsAfterResize > measurementsAfterUpdates,
  destroyedSvgCount: plot.querySelectorAll('svg').length,
  destroyRemovedResizeListener: measurementCount === measurementsBeforeDestroyedResize
};`,
    );
    const dom = new JSDOM(source, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'http://localhost/',
    });
    const result = (
      dom.window as unknown as {
        plotStabilityResult?: Record<string, unknown>;
      }
    ).plotStabilityResult;
    expect(result).toMatchObject({
      initialWidth: '720',
      initialHeight: '420',
      updatedWidth: '720',
      updatedHeight: '420',
      svgCountAfterUpdates: 1,
      measurementsAfterUpdates: 1,
      resizedWidth: '900',
      resizedHeight: '500',
      resizeWasRerendered: true,
      sameSizeWasNoop: true,
      resizeMeasured: true,
      destroyedSvgCount: 0,
      destroyRemovedResizeListener: true,
    });
    expect(result?.initialCurve).toBe(result?.updatedCurve);
    dom.window.close();
  });

  it('waits for a real non-zero layout before the first render and disconnects readiness observation', () => {
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script>`;
    const source = srcdoc(
      marker,
      `
class ControlledResizeObserver {
  static instance;
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    ControlledResizeObserver.instance = this;
  }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
  trigger() { this.callback([{ target: this.target }], this); }
}
window.ResizeObserver = ControlledResizeObserver;
const plot = document.getElementById('plot');
let layoutWidth = 0;
let layoutHeight = 0;
let measurementCount = 0;
plot.getBoundingClientRect = () => {
  measurementCount += 1;
  return {
    x: 0, y: 0, top: 0, right: layoutWidth, bottom: layoutHeight, left: 0,
    width: layoutWidth, height: layoutHeight, toJSON() {}
  };
};
const config = window.ReachFunctionPlot.config('main');
const controller = window.ReachFunctionPlot.mount(plot, config);
const svgCountAtZeroSize = plot.querySelectorAll('svg').length;
controller.setParameters({ a: 1.5 });
const svgCountAfterHiddenUpdate = plot.querySelectorAll('svg').length;
window.dispatchEvent(new CustomEvent('reach-interactive-resize', {
  detail: { width: 1024, height: 768 }
}));
const svgCountAfterZeroSizeResize = plot.querySelectorAll('svg').length;
layoutWidth = 680;
layoutHeight = 380;
window.dispatchEvent(new CustomEvent('reach-interactive-resize', {
  detail: { width: 1024, height: 768 }
}));
const recoveredSvg = plot.querySelector('svg');
const recoveredParameters = controller.getParameters();
const observerDisconnected = ControlledResizeObserver.instance.disconnected;
controller.destroy();
const measurementsBeforeDestroyedTrigger = measurementCount;
ControlledResizeObserver.instance.trigger();
const pendingPlot = document.createElement('div');
document.body.append(pendingPlot);
let pendingMeasurementCount = 0;
pendingPlot.getBoundingClientRect = () => {
  pendingMeasurementCount += 1;
  return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON() {} };
};
const pendingController = window.ReachFunctionPlot.mount(pendingPlot, config);
const pendingObserver = ControlledResizeObserver.instance;
pendingController.destroy();
pendingObserver.trigger();
window.zeroSizeRecoveryResult = {
  svgCountAtZeroSize,
  svgCountAfterHiddenUpdate,
  svgCountAfterZeroSizeResize,
  recoveredWidth: recoveredSvg.getAttribute('width'),
  recoveredHeight: recoveredSvg.getAttribute('height'),
  recoveredParameters,
  observerDisconnected,
  destroyedSvgCount: plot.querySelectorAll('svg').length,
  destroyKeptObserverDisconnected: ControlledResizeObserver.instance.disconnected,
  destroyPreventedFurtherMeasurement: measurementCount === measurementsBeforeDestroyedTrigger,
  pendingObserverDisconnectedOnDestroy: pendingObserver.disconnected,
  pendingDestroyPreventedFurtherMeasurement: pendingMeasurementCount === 1
};`,
    );
    const dom = new JSDOM(source, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'http://localhost/',
    });
    const result = (
      dom.window as unknown as {
        zeroSizeRecoveryResult?: Record<string, unknown>;
      }
    ).zeroSizeRecoveryResult;
    expect(result).toMatchObject({
      svgCountAtZeroSize: 0,
      svgCountAfterHiddenUpdate: 0,
      svgCountAfterZeroSizeResize: 0,
      recoveredWidth: '680',
      recoveredHeight: '380',
      recoveredParameters: { a: 1.5 },
      observerDisconnected: true,
      destroyedSvgCount: 0,
      destroyKeptObserverDisconnected: true,
      destroyPreventedFurtherMeasurement: true,
      pendingObserverDisconnectedOnDestroy: true,
      pendingDestroyPreventedFurtherMeasurement: true,
    });
    dom.window.close();
  });

  it('validates hidden parameter updates synchronously and rolls back before deferred rendering', () => {
    const disappearingIntersectionSpec = {
      ...plotSpec,
      series: [
        { id: 'quadratic', expression: 'x^2+a', colorToken: 'accent' },
        { id: 'axis', expression: '0', colorToken: 'warning' },
      ],
      parameters: [
        { id: 'a', label: 'Vertical offset', minimum: -1, maximum: 1, step: 0.1, initial: -1 },
      ],
      markers: [],
      intersections: [
        {
          id: 'cross',
          firstSeriesId: 'quadratic',
          secondSeriesId: 'axis',
          x: 1,
          label: 'Intersection',
        },
      ],
    } as const;
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(disappearingIntersectionSpec)}</script>`;
    const source = srcdoc(
      marker,
      `
class ControlledResizeObserver {
  static instance;
  constructor(callback) { this.callback = callback; ControlledResizeObserver.instance = this; }
  observe(target) { this.target = target; }
  disconnect() { this.disconnected = true; }
  trigger() { this.callback([{ target: this.target }], this); }
}
window.ResizeObserver = ControlledResizeObserver;
const plot = document.getElementById('plot');
let layoutWidth = 0;
let layoutHeight = 0;
plot.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, right: layoutWidth, bottom: layoutHeight, left: 0,
  width: layoutWidth, height: layoutHeight, toJSON() {}
});
const config = window.ReachFunctionPlot.config('main');
const controller = window.ReachFunctionPlot.mount(plot, config);
let updateError;
try {
  controller.setParameters({ a: 1 });
} catch (error) {
  updateError = error.message;
}
layoutWidth = 640;
layoutHeight = 360;
ControlledResizeObserver.instance.trigger();
window.hiddenValidationResult = {
  updateError,
  parameters: controller.getParameters(),
  svgCount: plot.querySelectorAll('svg').length,
  renderError: plot.getAttribute('data-reach-function-plot-error')
};
controller.destroy();`,
    );
    const dom = new JSDOM(source, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'http://localhost/',
    });
    const result = (
      dom.window as unknown as {
        hiddenValidationResult?: Record<string, unknown>;
      }
    ).hiddenValidationResult;
    expect(result).toMatchObject({
      updateError: 'Function plot intersection cross is inconsistent.',
      parameters: { a: -1 },
      svgCount: 1,
      renderError: null,
    });
    dom.window.close();
  });
});
