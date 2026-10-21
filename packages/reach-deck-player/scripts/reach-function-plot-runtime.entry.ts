import functionPlotImport from 'function-plot';
import { Parser } from 'expr-eval-fork';
import { resolveReachFunctionPlotIntersection } from '@reachany/reach-deck-dsl/function-plot-geometry';

type PlotFunctionSeries = {
  kind?: 'function';
  id: string;
  expression: string;
  colorToken: keyof typeof COLORS;
  domain?: [number, number];
};

type PlotPointsSeries = {
  kind: 'points';
  id: string;
  points: Array<{ x: number; y: number }>;
  render: 'scatter' | 'polyline';
  colorToken: keyof typeof COLORS;
};

type PlotSpec = {
  schemaVersion: 'reach-function-plot/v1' | 'reach-function-plot/v2';
  ariaLabel: string;
  viewport: { x: [number, number]; y: [number, number] };
  axes: { grid: boolean; xLabel?: string; yLabel?: string };
  series: Array<PlotFunctionSeries | PlotPointsSeries>;
  parameters: Array<{
    id: string;
    label: string;
    minimum: number;
    maximum: number;
    step: number;
    initial: number;
  }>;
  markers: Array<{ id: string; seriesId: string; x: number; label?: string }>;
  intersections: Array<{
    id: string;
    firstSeriesId: string;
    secondSeriesId: string;
    x: number;
    label?: string;
  }>;
};

type PlotController = {
  setParameters: (values: Record<string, number>) => Readonly<Record<string, number>>;
  getParameters: () => Readonly<Record<string, number>>;
  destroy: () => void;
};

type RenderSize = {
  width: number;
  height: number;
};

type RenderMeasurement = {
  size: RenderSize;
  layoutReady: boolean;
};

const COLORS = {
  ink: '#172033',
  muted: '#64748b',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#d97706',
} as const;
const functionPlot =
  typeof functionPlotImport === 'function'
    ? functionPlotImport
    : (
        functionPlotImport as unknown as {
          default: typeof functionPlotImport;
        }
      ).default;
const MAX_RENDER_WIDTH = 1600;
const MAX_RENDER_HEIGHT = 900;
const POINT_SCATTER_ATTRIBUTES = Object.freeze({
  r: 4,
  opacity: 0.86,
  'stroke-width': 1.5,
});
const POINT_POLYLINE_ATTRIBUTES = Object.freeze({
  fill: 'none',
  opacity: 0.92,
  'stroke-linecap': 'round',
  'stroke-width': 3,
});
const SEMANTIC_POINT_ATTRIBUTES = Object.freeze({
  fill: COLORS.accent,
  opacity: 1,
  r: 5,
  stroke: '#ffffff',
  'stroke-width': 2,
});
const parser = new Parser({
  allowMemberAccess: false,
  operators: {
    assignment: false,
    concatenate: false,
    conditional: false,
    factorial: false,
    fndef: false,
    in: false,
    logical: false,
    random: false,
  },
});
const validatedSpecs = new WeakSet<object>();
const specsById = new Map<string, PlotSpec>();

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const install = (entries: ReadonlyArray<{ id: string; spec: PlotSpec }>) => {
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.spec ||
      (entry.spec.schemaVersion !== 'reach-function-plot/v1' &&
        entry.spec.schemaVersion !== 'reach-function-plot/v2')
    ) {
      throw new Error('Invalid Reach function plot registry.');
    }
    const spec = deepFreeze(JSON.parse(JSON.stringify(entry.spec)) as PlotSpec);
    validatedSpecs.add(spec);
    specsById.set(entry.id, spec);
  }

  const api = Object.freeze({
    config: (id: string): PlotSpec | undefined => specsById.get(String(id)),
    mount: (target: HTMLElement, spec: PlotSpec): PlotController => mount(target, spec),
  });
  Object.defineProperty(window, 'ReachFunctionPlot', {
    value: api,
    configurable: false,
    writable: false,
  });
};

function mount(target: HTMLElement, spec: PlotSpec): PlotController {
  if (!(target instanceof HTMLElement) || !validatedSpecs.has(spec)) {
    throw new Error('ReachFunctionPlot accepts only a target element and host-validated config.');
  }
  const functionSeries = spec.series.filter(
    (series): series is PlotFunctionSeries => series.kind !== 'points',
  );
  const expressions = new Map(
    functionSeries.map((series) => {
      const expression = parser.parse(series.expression);
      const allowed = new Set(['x', ...spec.parameters.map((parameter) => parameter.id)]);
      if (expression.variables().some((symbol) => !allowed.has(symbol))) {
        throw new Error('Function plot expression contains an undeclared symbol.');
      }
      return [series.id, expression] as const;
    }),
  );
  let parameters = Object.fromEntries(
    spec.parameters.map((parameter) => [parameter.id, parameter.initial]),
  );
  const intersectionHints = new Map<string, number>();
  let intersectionsVerified = false;
  let destroyed = false;
  let hasRendered = false;
  let lastResizeViewport: RenderSize | undefined;
  let readinessObserver: ResizeObserver | undefined;

  const snapshot = () => Object.freeze({ ...parameters });
  const evaluate = (seriesId: string, x: number): number => {
    const expression = expressions.get(seriesId);
    if (!expression || !finite(x)) throw new Error('Invalid function plot evaluation.');
    const scope = Object.assign(Object.create(null), parameters, { x });
    const result = expression.evaluate(scope);
    return finite(result) ? result : Number.NaN;
  };
  const resolveAnnotations = (allowWideIntersectionSearch = intersectionsVerified) => {
    const pointData: Array<Record<string, unknown>> = [];
    const labels: Array<{ x: number; y: number; text: string; color: string }> = [];
    for (const marker of spec.markers) {
      const y = evaluate(marker.seriesId, marker.x);
      if (!finite(y)) continue;
      const color = COLORS[spec.series.find((series) => series.id === marker.seriesId)!.colorToken];
      pointData.push({
        attr: { ...SEMANTIC_POINT_ATTRIBUTES, fill: color, stroke: '#ffffff' },
        fnType: 'points',
        graphType: 'scatter',
        points: [[marker.x, y]],
        color,
      });
      if (marker.label) {
        labels.push({ x: marker.x, y, text: marker.label, color });
      }
    }
    for (const intersection of spec.intersections) {
      const hint = intersectionHints.get(intersection.id) ?? intersection.x;
      let resolved = resolveReachFunctionPlotIntersection(
        (x) => evaluate(intersection.firstSeriesId, x),
        (x) => evaluate(intersection.secondSeriesId, x),
        hint,
        spec.viewport.x,
        spec.viewport.y,
      );
      if (resolved === undefined && allowWideIntersectionSearch) {
        resolved = resolveReachFunctionPlotIntersection(
          (x) => evaluate(intersection.firstSeriesId, x),
          (x) => evaluate(intersection.secondSeriesId, x),
          hint,
          spec.viewport.x,
          spec.viewport.y,
          1,
        );
      }
      if (resolved === undefined) {
        throw new Error(`Function plot intersection ${intersection.id} is inconsistent.`);
      }
      intersectionHints.set(intersection.id, resolved.x);
      pointData.push({
        attr: SEMANTIC_POINT_ATTRIBUTES,
        fnType: 'points',
        graphType: 'scatter',
        points: [[resolved.x, resolved.y]],
        color: COLORS.accent,
      });
      if (intersection.label) {
        labels.push({
          x: resolved.x,
          y: resolved.y,
          text: intersection.label,
          color: COLORS.accent,
        });
      }
    }
    return { pointData, labels };
  };
  const measureRenderSize = (): RenderMeasurement => {
    const rect = target.getBoundingClientRect();
    return {
      size: {
        width: Math.min(MAX_RENDER_WIDTH, Math.max(320, Math.round(rect.width || 640))),
        height: Math.min(MAX_RENDER_HEIGHT, Math.max(240, Math.round(rect.height || 360))),
      },
      layoutReady: rect.width > 0 && rect.height > 0,
    };
  };
  const initialMeasurement = measureRenderSize();
  let renderSize = initialMeasurement.size;
  const render = ({ width, height }: RenderSize = renderSize) => {
    if (destroyed) throw new Error('Function plot controller is disposed.');
    const { pointData, labels } = resolveAnnotations();
    target.replaceChildren();
    target.setAttribute('role', 'img');
    target.setAttribute('aria-label', spec.ariaLabel);
    const chart = functionPlot({
      target,
      width,
      height,
      disableZoom: true,
      grid: spec.axes.grid,
      xAxis: { domain: spec.viewport.x, label: spec.axes.xLabel, position: 'sticky' },
      yAxis: { domain: spec.viewport.y, label: spec.axes.yLabel, position: 'sticky' },
      data: [
        ...spec.series.map((series) =>
          series.kind === 'points'
            ? {
                attr:
                  series.render === 'scatter'
                    ? POINT_SCATTER_ATTRIBUTES
                    : POINT_POLYLINE_ATTRIBUTES,
                fnType: 'points' as const,
                graphType: series.render,
                points: series.points.map(({ x, y }) => [x, y]),
                skipTip: true,
                color: COLORS[series.colorToken],
              }
            : {
                fn: (scope: Record<string, unknown>) => evaluate(series.id, Number(scope.x)),
                fnType: 'linear' as const,
                graphType: 'polyline' as const,
                sampler: 'builtIn' as const,
                nSamples: Math.min(800, Math.max(240, width)),
                color: COLORS[series.colorToken],
                ...(series.domain === undefined ? {} : { range: series.domain }),
              },
        ),
        ...pointData,
      ],
    });
    const svg = target.querySelector('svg');
    if (svg && labels.length > 0) {
      const group = target.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('data-reach-function-plot-markers', '');
      for (const label of labels) {
        const text = target.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(chart.meta.xScale(label.x) + 8));
        text.setAttribute('y', String(chart.meta.yScale(label.y) - 8));
        text.setAttribute('fill', label.color);
        text.setAttribute('font-size', '14');
        text.setAttribute('font-weight', '600');
        text.textContent = label.text;
        group.append(text);
      }
      svg.append(group);
    }
    intersectionsVerified = true;
    hasRendered = true;
  };
  const stopReadinessObservation = () => {
    readinessObserver?.disconnect();
    readinessObserver = undefined;
  };
  const renderRecoveredLayout = (measurement: RenderMeasurement) => {
    const previousIntersectionHints = new Map(intersectionHints);
    const previousIntersectionsVerified = intersectionsVerified;
    const previousHasRendered = hasRendered;
    try {
      render(measurement.size);
      renderSize = measurement.size;
      target.removeAttribute('data-reach-function-plot-error');
      stopReadinessObservation();
      return true;
    } catch {
      intersectionHints.clear();
      for (const [id, x] of previousIntersectionHints) intersectionHints.set(id, x);
      intersectionsVerified = previousIntersectionsVerified;
      hasRendered = previousHasRendered;
      target.setAttribute('data-reach-function-plot-error', 'render-failed');
      stopReadinessObservation();
      return false;
    }
  };
  const renderWhenLayoutReady = () => {
    if (destroyed) return;
    const measurement = measureRenderSize();
    if (!measurement.layoutReady) return;
    renderRecoveredLayout(measurement);
  };
  const handleResize = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object') return;
    const { width, height } = detail as { width?: unknown; height?: unknown };
    if (!finite(width) || !finite(height)) return;
    const viewport = { width: Math.round(width), height: Math.round(height) };
    if (
      lastResizeViewport?.width === viewport.width &&
      lastResizeViewport.height === viewport.height
    ) {
      return;
    }
    const measurement = measureRenderSize();
    if (!measurement.layoutReady) {
      return;
    }
    if (
      hasRendered &&
      measurement.size.width === renderSize.width &&
      measurement.size.height === renderSize.height
    ) {
      lastResizeViewport = viewport;
      stopReadinessObservation();
      return;
    }
    if (!renderRecoveredLayout(measurement)) return;
    lastResizeViewport = viewport;
  };

  if (initialMeasurement.layoutReady || typeof ResizeObserver !== 'function') {
    render();
  } else {
    readinessObserver = new ResizeObserver(renderWhenLayoutReady);
    readinessObserver.observe(target);
  }
  window.addEventListener('reach-interactive-resize', handleResize);
  return Object.freeze({
    setParameters: (values: Record<string, number>) => {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('Function plot parameter update must be a finite scalar map.');
      }
      const declared = new Map(spec.parameters.map((parameter) => [parameter.id, parameter]));
      const next = { ...parameters };
      for (const [id, value] of Object.entries(values)) {
        const parameter = declared.get(id);
        if (
          !parameter ||
          !finite(value) ||
          value < parameter.minimum ||
          value > parameter.maximum
        ) {
          throw new Error('Function plot parameter update is outside its declared bounds.');
        }
        next[id] = value;
      }
      const previous = parameters;
      const previousIntersectionHints = new Map(intersectionHints);
      const previousIntersectionsVerified = intersectionsVerified;
      parameters = next;
      try {
        if (hasRendered) {
          render();
        } else {
          resolveAnnotations(true);
          intersectionsVerified = true;
        }
      } catch (error) {
        parameters = previous;
        intersectionHints.clear();
        for (const [id, x] of previousIntersectionHints) intersectionHints.set(id, x);
        intersectionsVerified = previousIntersectionsVerified;
        throw error;
      }
      return snapshot();
    },
    getParameters: snapshot,
    destroy: () => {
      window.removeEventListener('reach-interactive-resize', handleResize);
      stopReadinessObservation();
      destroyed = true;
      target.replaceChildren();
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

Object.defineProperty(window, '__installReachFunctionPlot', {
  value: install,
  configurable: true,
  writable: false,
});
