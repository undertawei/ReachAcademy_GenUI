import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  REACH_FUNCTION_PLOT_LIMITS,
  parseReachFunctionPlotAnimationValue,
  parseReachFunctionPlotSpecValue,
  reachFunctionPlotAnimationFrameCount,
  resolveReachFunctionPlotIntersection,
  type ReachFunctionPlotAnimation,
  type ReachFunctionPlotColorToken,
  type ReachFunctionPlotSpec,
} from '@reachany/reach-deck-dsl';
import { Parser, type Expression } from 'expr-eval-fork';
import { create, type Font } from 'fontkit';
import type { Chart, FunctionPlotOptions } from 'function-plot';
import { Window } from 'happy-dom';
import sharp from 'sharp';

import { CODE_MEDIA_LIMITS } from './code-media-policy.js';
import { resolveReachDeckRuntimeAsset } from './runtime-assets.js';
import {
  estimateTextWidth,
  formatTick,
  niceTicks,
  type QuantitativeDisplayTypography,
} from './quantitative-display.js';

export const REACH_FUNCTION_PLOT_RENDERER_VERSION = 'function-plot-png/v4' as const;
/** Tracer GIF: frames drawn from the static SVG plus a per-frame overlay, encoded by sharp. */
export const REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION =
  `${REACH_FUNCTION_PLOT_RENDERER_VERSION}+tracer-gif/v1` as const;

export const REACH_FUNCTION_PLOT_ANIMATION_RENDER_LIMITS = Object.freeze({
  maximumGifBytes: CODE_MEDIA_LIMITS.outputBytes,
  maximumRenderMilliseconds: 30_000,
});

export const REACH_FUNCTION_PLOT_RENDER_LIMITS = Object.freeze({
  height: { minimum: 240, maximum: 1_080 },
  maximumPixels: 2_073_600,
  maximumPngBytes: 8 * 1024 * 1024,
  maximumRenderMilliseconds: 5_000,
  maximumSvgBytes: 1024 * 1024,
  samplesPerSeries: 320,
  width: { minimum: 320, maximum: 1_920 },
});

export const REACH_FUNCTION_PLOT_REQUIRED_FONT_FILES = ['SourceHanSans-VF.ttf'] as const;
const FONT_FAMILY = 'Source Han Sans VF';

const DEFAULT_COLORS: Readonly<Record<ReachFunctionPlotColorToken, string>> = Object.freeze({
  ink: '#0f172a',
  muted: '#64748b',
  accent: '#2563eb',
  success: '#16a34a',
  warning: '#dc2626',
});
const DEFAULT_BACKGROUND = '#ffffff';
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
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_SVG_ELEMENTS = new Set([
  'circle',
  'clippath',
  'defs',
  'g',
  'line',
  'marker',
  'path',
  'rect',
  'svg',
  'text',
  'title',
]);
const ALLOWED_SVG_ATTRIBUTES = new Set([
  'aria-label',
  'class',
  'clip-path',
  'cx',
  'cy',
  'd',
  'dx',
  'dy',
  'fill',
  'fill-opacity',
  'font-family',
  'font-size',
  'height',
  'id',
  'markerheight',
  'markerwidth',
  'opacity',
  'orient',
  'r',
  'refx',
  'refy',
  'role',
  'shape-rendering',
  'stroke',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'transform',
  'viewbox',
  'width',
  'x',
  'x1',
  'x2',
  'xmlns',
  'y',
  'y1',
  'y2',
]);
const NUMERIC_SVG_ATTRIBUTES = new Set([
  'dx',
  'dy',
  'cx',
  'cy',
  'fill-opacity',
  'font-size',
  'height',
  'markerheight',
  'markerwidth',
  'opacity',
  'r',
  'refx',
  'refy',
  'stroke-opacity',
  'stroke-width',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
]);
const SAFE_SVG_TOKEN = /^[A-Za-z0-9_. -]{0,240}$/;
const SAFE_SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/;
const SAFE_SVG_TRANSFORM = /^(?:\s*(?:translate|scale|rotate|matrix)\([-+0-9eE.,\s]+\)\s*)+$/;

type FunctionPlot = (options: FunctionPlotOptions) => Chart;

export interface ReachFunctionPlotRenderInput {
  spec: unknown;
  width: number;
  height: number;
  background?: string;
  colors?: Partial<Record<ReachFunctionPlotColorToken, string>>;
  parameterValues?: Readonly<Record<string, number>>;
  fontDirectory?: string;
  /**
   * Logical drawing size (displayed px). width/height stay the raster size, so a slot-sized
   * render draws in slot px and rasterizes at the device scale. Defaults to width/height.
   */
  viewport?: { width: number; height: number };
  /** Tick/marker and axis-title sizes in logical px. Defaults: 18 and 22. */
  typography?: QuantitativeDisplayTypography;
}

/** Default text sizes of production renders, in logical px. */
const DEFAULT_TYPOGRAPHY: QuantitativeDisplayTypography = Object.freeze({ tick: 18, title: 22 });

export interface ReachFunctionPlotRenderResult {
  rendererVersion: typeof REACH_FUNCTION_PLOT_RENDERER_VERSION;
  normalizedSpec: ReachFunctionPlotSpec;
  png: Uint8Array;
  pngSha256: string;
  svg: string;
  width: number;
  height: number;
}

interface CompiledFunctionSeries {
  kind: 'function';
  id: string;
  evaluate(x: number): number;
  color: string;
  domain?: [number, number];
}

interface CompiledPointsSeries {
  kind: 'points';
  id: string;
  points: Array<[number, number]>;
  render: 'scatter' | 'polyline';
  color: string;
}

type CompiledSeries = CompiledFunctionSeries | CompiledPointsSeries;

const parserOptions = {
  allowMemberAccess: false,
  operators: {
    assignment: false,
    comparison: false,
    concatenate: false,
    conditional: false,
    factorial: false,
    fndef: false,
    in: false,
    length: false,
    logical: false,
    random: false,
    remainder: false,
  },
} as const;

const makeExpressionParser = (): Parser => {
  const parser = new Parser(parserOptions);
  const allowedFunctions = new Set(['atan2', 'hypot', 'max', 'min', 'pow']);
  for (const name of Object.keys(parser.functions)) {
    if (!allowedFunctions.has(name)) delete parser.functions[name];
  }
  parser.functions = Object.assign(Object.create(null), parser.functions);
  parser.consts = Object.assign(Object.create(null), {
    E: Math.E,
    PI: Math.PI,
  });
  return parser;
};

const assertFiniteScalarRecord = (
  values: Readonly<Record<string, number>> | undefined,
): Record<string, number> => {
  const normalized: Record<string, number> = Object.create(null) as Record<string, number>;
  if (values === undefined) return normalized;
  const prototype = Object.getPrototypeOf(values);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Function plot parameter scope must be an ordinary JSON object.');
  }
  for (const [name, value] of Object.entries(values)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ||
      typeof value !== 'number' ||
      !Number.isFinite(value)
    ) {
      throw new Error('Function plot parameter scope accepts finite scalar values only.');
    }
    normalized[name] = value;
  }
  return normalized;
};

export const createReachFunctionPlotScope = (
  x: number,
  parameterValues: Readonly<Record<string, number>>,
): Record<string, number> => {
  if (!Number.isFinite(x)) throw new Error('Function plot x must be finite.');
  const scope = assertFiniteScalarRecord(parameterValues);
  scope.x = x;
  return scope;
};

const evaluateFinite = (
  expression: Expression,
  x: number,
  parameterValues: Readonly<Record<string, number>>,
): number => {
  const result: unknown = expression.evaluate(createReachFunctionPlotScope(x, parameterValues));
  return typeof result === 'number' && Number.isFinite(result) ? result : Number.NaN;
};

export const compileReachFunctionPlotSeries = (
  specValue: unknown,
  inputParameterValues?: Readonly<Record<string, number>>,
  inputColors?: Partial<Record<ReachFunctionPlotColorToken, string>>,
): {
  spec: ReachFunctionPlotSpec;
  series: CompiledSeries[];
  functionSeries: CompiledFunctionSeries[];
  parameterValues: Record<string, number>;
} => {
  const spec = parseReachFunctionPlotSpecValue(specValue);
  const suppliedValues = assertFiniteScalarRecord(inputParameterValues);
  const declaredParameterIds = new Set(spec.parameters.map(({ id }) => id));
  if (Object.keys(suppliedValues).some((id) => !declaredParameterIds.has(id))) {
    throw new Error('Function plot parameter scope contains an undeclared variable.');
  }
  const parameterValues: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const parameter of spec.parameters) {
    const value = suppliedValues[parameter.id] ?? parameter.initial;
    if (value < parameter.minimum || value > parameter.maximum) {
      throw new Error(`Function plot parameter ${parameter.id} is outside its declared bounds.`);
    }
    parameterValues[parameter.id] = value;
  }

  const colors = { ...DEFAULT_COLORS };
  for (const [token, value] of Object.entries(inputColors ?? {})) {
    if (!HEX_COLOR.test(value)) throw new Error(`Function plot color ${token} is invalid.`);
    colors[token as ReachFunctionPlotColorToken] = value;
  }
  const parser = makeExpressionParser();
  const allowedVariables = new Set(['x', ...declaredParameterIds]);
  const series = spec.series.map((candidate): CompiledSeries => {
    if ('kind' in candidate && candidate.kind === 'points') {
      return {
        kind: 'points',
        id: candidate.id,
        points: candidate.points.map(({ x, y }) => [x, y]),
        render: candidate.render,
        color: colors[candidate.colorToken],
      };
    }
    let expression: Expression;
    try {
      expression = parser.parse(candidate.expression);
    } catch {
      throw new Error(`Function plot series ${candidate.id} expression is invalid.`);
    }
    const variables = expression.variables({ withMembers: true });
    if (variables.some((name) => !allowedVariables.has(name))) {
      throw new Error(`Function plot series ${candidate.id} uses an undeclared variable.`);
    }
    const evaluate = (x: number): number => evaluateFinite(expression, x, parameterValues);
    const probes = [
      spec.viewport.x[0],
      (spec.viewport.x[0] + spec.viewport.x[1]) / 2,
      spec.viewport.x[1],
    ];
    if (probes.every((x) => !Number.isFinite(evaluate(x)))) {
      throw new Error(`Function plot series ${candidate.id} has no finite probe value.`);
    }
    return {
      kind: 'function',
      id: candidate.id,
      evaluate,
      color: colors[candidate.colorToken],
      ...(candidate.domain === undefined ? {} : { domain: candidate.domain }),
    };
  });
  const functionSeries = series.filter(
    (candidate): candidate is CompiledFunctionSeries => candidate.kind === 'function',
  );
  return { spec, series, functionSeries, parameterValues };
};

const assertDimension = (
  value: number,
  limits: { minimum: number; maximum: number },
  name: string,
): number => {
  if (!Number.isInteger(value) || value < limits.minimum || value > limits.maximum) {
    throw new Error(`Function plot ${name} is outside renderer limits.`);
  }
  return value;
};

const resolveColors = (
  input?: Partial<Record<ReachFunctionPlotColorToken, string>>,
): Record<ReachFunctionPlotColorToken, string> => {
  const colors = { ...DEFAULT_COLORS };
  for (const [token, value] of Object.entries(input ?? {})) {
    if (!HEX_COLOR.test(value)) throw new Error(`Function plot color ${token} is invalid.`);
    colors[token as ReachFunctionPlotColorToken] = value;
  }
  return colors;
};

const resolveFunctionPlot = async (): Promise<FunctionPlot> => {
  const imported = await import('function-plot');
  const firstDefault: unknown = imported.default;
  const candidate =
    typeof firstDefault === 'function'
      ? firstDefault
      : typeof firstDefault === 'object' && firstDefault !== null && 'default' in firstDefault
        ? (firstDefault as { default: unknown }).default
        : undefined;
  if (typeof candidate !== 'function') throw new Error('function-plot export is unavailable.');
  return candidate as FunctionPlot;
};

const globalDomKeys = [
  'window',
  'document',
  'navigator',
  'Element',
  'HTMLElement',
  'SVGElement',
  'Node',
] as const;

const installWindowGlobals = (window: Window): (() => void) => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const values: Record<(typeof globalDomKeys)[number], unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Node: window.Node,
  };
  for (const key of globalDomKeys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: values[key],
    });
  }
  return () => {
    for (const key of globalDomKeys) {
      const descriptor = previous.get(key);
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  };
};

const appendSemanticMarkers = (
  document: Document,
  svg: SVGSVGElement,
  chart: Chart,
  spec: ReachFunctionPlotSpec,
  series: CompiledFunctionSeries[],
  labelSize: number,
): void => {
  const canvas = svg.querySelector<SVGGElement>('g.canvas');
  if (canvas === null) throw new Error('Function plot renderer produced no canvas group.');
  const byId = new Map(series.map((candidate) => [candidate.id, candidate]));
  const points: Array<{ id: string; x: number; y: number; label?: string; color: string }> = [];
  for (const marker of spec.markers) {
    const target = byId.get(marker.seriesId)!;
    const y = target.evaluate(marker.x);
    if (!Number.isFinite(y)) throw new Error(`Function plot marker ${marker.id} is non-finite.`);
    points.push({ id: marker.id, x: marker.x, y, label: marker.label, color: target.color });
  }
  for (const intersection of spec.intersections) {
    const first = byId.get(intersection.firstSeriesId)!;
    const second = byId.get(intersection.secondSeriesId)!;
    const resolved = resolveReachFunctionPlotIntersection(
      first.evaluate,
      second.evaluate,
      intersection.x,
      spec.viewport.x,
      spec.viewport.y,
    );
    if (resolved === undefined) {
      throw new Error(`Function plot intersection ${intersection.id} is inconsistent.`);
    }
    points.push({
      id: intersection.id,
      x: resolved.x,
      y: resolved.y,
      label: intersection.label,
      color: first.color,
    });
  }
  const xScale = chart.meta.xScale;
  const yScale = chart.meta.yScale;
  if (xScale === undefined || yScale === undefined) {
    throw new Error('Function plot renderer produced no finite coordinate scales.');
  }
  for (const point of points) {
    const x = xScale(point.x);
    const y = yScale(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Function plot semantic point ${point.id} is outside finite geometry.`);
    }
    const group = document.createElementNS(SVG_NAMESPACE, 'g');
    group.setAttribute('class', 'reach-function-plot-marker');
    group.setAttribute('data-marker-id', point.id);
    const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
    circle.setAttribute('cx', String(x));
    circle.setAttribute('cy', String(y));
    circle.setAttribute('r', String(Math.max(5, Math.round(labelSize * 0.3))));
    circle.setAttribute('fill', point.color);
    circle.setAttribute('stroke', '#ffffff');
    circle.setAttribute('stroke-width', '2');
    group.append(circle);
    if (point.label !== undefined) {
      const text = document.createElementNS(SVG_NAMESPACE, 'text');
      text.setAttribute('x', String(x + Math.round(labelSize * 0.45)));
      text.setAttribute('y', String(y - Math.round(labelSize * 0.45)));
      text.setAttribute('font-size', String(labelSize));
      text.setAttribute('fill', '#0f172a');
      text.textContent = point.label;
      group.append(text);
    }
    canvas.append(group);
  }
};

const isFiniteNumberList = (value: string): boolean => {
  const numbers = value.trim().split(/[ ,]+/).filter(Boolean).map(Number);
  return numbers.length > 0 && numbers.every(Number.isFinite);
};

const containsOnlyFiniteNumericTokens = (value: string): boolean =>
  [...value.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)].every((match) =>
    Number.isFinite(Number(match[0])),
  );

const assertSanitizedSvgTree = (svg: SVGSVGElement): void => {
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_SVG_ELEMENTS.has(tag)) {
      throw new Error(`Function plot SVG retained forbidden element ${tag}.`);
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'href' || name === 'src') {
        throw new Error(`Function plot SVG retained forbidden attribute ${name}.`);
      }
      if (NUMERIC_SVG_ATTRIBUTES.has(name) && !isFiniteNumberList(attribute.value)) {
        throw new Error(`Function plot SVG retained non-finite geometry in ${name}.`);
      }
      if (
        (name === 'd' || name === 'transform') &&
        (/NaN|Infinity/i.test(attribute.value) || !containsOnlyFiniteNumericTokens(attribute.value))
      ) {
        throw new Error(`Function plot SVG retained non-finite geometry in ${name}.`);
      }
    }
  }
};

const sanitizeSvgElement = (
  svg: SVGSVGElement,
  expectedWidth: number,
  expectedHeight: number,
  viewport: { width: number; height: number } = { width: expectedWidth, height: expectedHeight },
): string => {
  const idMap = new Map<string, string>();
  [...svg.querySelectorAll('[id]')].forEach((element, index) => {
    const original = element.getAttribute('id');
    if (original === null) return;
    const canonical = `reach-function-plot-${index + 1}`;
    idMap.set(original, canonical);
    element.setAttribute('id', canonical);
  });
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      let value = attribute.value;
      for (const [original, canonical] of idMap) {
        value = value.replaceAll(`url(#${original})`, `url(#${canonical})`);
        if (value === `#${original}`) value = `#${canonical}`;
      }
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
  }
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_SVG_ELEMENTS.has(tag)) {
      element.remove();
      continue;
    }
    if (tag === 'rect' && element.classList.contains('zoom-and-drag')) {
      // function-plot expresses this trusted transparent hit target through an
      // inline style. Convert the one required visual property before all
      // style attributes are removed by the generic sanitizer below.
      element.setAttribute('fill', 'none');
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      let keep = ALLOWED_SVG_ATTRIBUTES.has(name) && !name.startsWith('on');
      if (keep && NUMERIC_SVG_ATTRIBUTES.has(name)) keep = isFiniteNumberList(value);
      if (keep && name === 'd') {
        keep =
          value.length <= 256_000 &&
          SAFE_SVG_PATH.test(value) &&
          !/NaN|Infinity/i.test(value) &&
          containsOnlyFiniteNumericTokens(value);
      }
      if (keep && name === 'transform') {
        keep =
          value.length <= 240 &&
          SAFE_SVG_TRANSFORM.test(value) &&
          !/NaN|Infinity/i.test(value) &&
          containsOnlyFiniteNumericTokens(value);
      }
      if (keep && name === 'clip-path') keep = /^url\(#[A-Za-z0-9_.:-]{1,120}\)$/.test(value);
      if (keep && (name === 'class' || name === 'id' || name === 'orient')) {
        keep = SAFE_SVG_TOKEN.test(value);
      }
      if (keep && (name === 'fill' || name === 'stroke')) {
        keep =
          HEX_COLOR.test(value) ||
          value === 'none' ||
          value === 'black' ||
          value === 'currentColor';
      }
      if (!keep) element.removeAttribute(attribute.name);
    }
  }
  svg.setAttribute('xmlns', SVG_NAMESPACE);
  svg.setAttribute('width', String(expectedWidth));
  svg.setAttribute('height', String(expectedHeight));
  svg.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
  svg.setAttribute('font-family', FONT_FAMILY);
  assertSanitizedSvgTree(svg);
  const serialized = svg.outerHTML;
  if (Buffer.byteLength(serialized, 'utf8') > REACH_FUNCTION_PLOT_RENDER_LIMITS.maximumSvgBytes) {
    throw new Error('Function plot SVG failed the renderer-owned sanitization boundary.');
  }
  return serialized;
};

export const sanitizeReachFunctionPlotSvg = (
  svgText: string,
  expectedWidth: number,
  expectedHeight: number,
): string => {
  if (
    typeof svgText !== 'string' ||
    Buffer.byteLength(svgText, 'utf8') > REACH_FUNCTION_PLOT_RENDER_LIMITS.maximumSvgBytes
  ) {
    throw new Error('Function plot SVG is outside the sanitizer input limit.');
  }
  const window = new Window({ url: 'http://localhost' });
  try {
    window.document.body.innerHTML = svgText;
    const svg = window.document.body.querySelector('svg') as unknown as SVGSVGElement | null;
    if (svg === null || window.document.body.children.length !== 1) {
      throw new Error('Function plot sanitizer requires exactly one SVG root.');
    }
    return sanitizeSvgElement(svg, expectedWidth, expectedHeight);
  } finally {
    void window.close();
  }
};

export const resolveReachFunctionPlotFontDirectory = async (
  explicitDirectory = process.env.AI_RUNTIME_OFFICE_FONT_DIR?.trim(),
  cwd = process.cwd(),
): Promise<string> => {
  const candidates =
    explicitDirectory === undefined || explicitDirectory.length === 0
      ? [
          path.resolve(cwd, 'packages/reach-deck-player/fonts/sources'),
          path.resolve(cwd, '../../packages/reach-deck-player/fonts/sources'),
        ]
      : [path.resolve(explicitDirectory)];
  for (const candidate of candidates) {
    try {
      await Promise.all(
        REACH_FUNCTION_PLOT_REQUIRED_FONT_FILES.map((file) => access(path.join(candidate, file))),
      );
      return candidate;
    } catch {
      // Try the next repository-relative host-development candidate only.
    }
  }
  throw new Error('Required Reach function plot fonts are unavailable.');
};

let wasmInitialization: Promise<void> | undefined;
type ResvgWasmModule = typeof import('@resvg/resvg-wasm');

const loadResvgWasmModule = (): ResvgWasmModule => {
  const require = createRequire(import.meta.url);
  return require('@resvg/resvg-wasm') as ResvgWasmModule;
};

const ensureResvgWasm = async (): Promise<void> => {
  wasmInitialization ??= (async () => {
    const moduleEntry = resolveReachDeckRuntimeAsset('resvg-wasm');
    const bytes = await readFile(path.join(path.dirname(moduleEntry), 'index_bg.wasm'));
    try {
      const { initWasm } = loadResvgWasmModule();
      await initWasm(bytes);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Already initialized')) throw error;
    }
  })();
  await wasmInitialization;
};

const fontBufferCache = new Map<string, Promise<Uint8Array[]>>();
const loadFontBuffers = (directory: string): Promise<Uint8Array[]> => {
  const cached = fontBufferCache.get(directory);
  if (cached !== undefined) return cached;
  const loading = Promise.all(
    REACH_FUNCTION_PLOT_REQUIRED_FONT_FILES.map(async (file) =>
      Uint8Array.from(await readFile(path.join(directory, file))),
    ),
  );
  fontBufferCache.set(directory, loading);
  return loading;
};

let renderQueue: Promise<void> = Promise.resolve();

const inheritedSvgAttribute = (element: Element, name: string, fallback: string): string =>
  element.getAttribute(name) ??
  (element.parentElement ? inheritedSvgAttribute(element.parentElement, name, fallback) : fallback);

// The pinned WASM build can omit text despite supplied font buffers. Shape the
// renderer-owned labels explicitly so raster output never depends on that path.
const outlineSvgText = (svg: string, font: Font): string => {
  const window = new Window();
  try {
    window.document.body.innerHTML = svg;
    const root = window.document.body.querySelector('svg')!;
    for (const node of root.querySelectorAll('text')) {
      const text = node as unknown as Element;
      const run = font.layout(node.textContent ?? '');
      const scale = Number(inheritedSvgAttribute(text, 'font-size', '16')) / font.unitsPerEm;
      const anchor = inheritedSvgAttribute(text, 'text-anchor', 'start');
      const advance = run.positions.reduce((sum, position) => sum + position.xAdvance, 0) * scale;
      let x = Number(node.getAttribute('x') ?? 0) + Number(node.getAttribute('dx') ?? 0);
      const y = Number(node.getAttribute('y') ?? 0) + Number(node.getAttribute('dy') ?? 0);
      if (anchor === 'end') x -= advance;
      else if (anchor === 'middle') x -= advance / 2;
      const group = window.document.createElementNS(SVG_NAMESPACE, 'g');
      group.setAttribute('transform', node.getAttribute('transform') ?? 'translate(0,0)');
      const fill = inheritedSvgAttribute(text, 'fill', '#000000');
      group.setAttribute('fill', fill === 'currentColor' ? '#000000' : fill);
      run.glyphs.forEach((glyph, index) => {
        const position = run.positions[index]!;
        const path = window.document.createElementNS(SVG_NAMESPACE, 'path');
        path.setAttribute('d', glyph.path.toSVG());
        path.setAttribute(
          'transform',
          `translate(${x + position.xOffset * scale},${y - position.yOffset * scale}) scale(${scale},${-scale})`,
        );
        group.append(path);
        x += position.xAdvance * scale;
      });
      node.replaceWith(group);
    }
    assertSanitizedSvgTree(root as unknown as SVGSVGElement);
    const outlined = root.outerHTML;
    if (Buffer.byteLength(outlined, 'utf8') > REACH_FUNCTION_PLOT_RENDER_LIMITS.maximumSvgBytes) {
      throw new Error('Function plot outlined SVG is outside renderer limits.');
    }
    return outlined;
  } finally {
    void window.close();
  }
};

interface FunctionPlotLayout {
  viewport: { width: number; height: number };
  typography: QuantitativeDisplayTypography;
  pad: number;
  /** Inner plot rectangle in logical px. */
  plot: { left: number; top: number; width: number; height: number };
  xTicks: number[];
  yTicks: number[];
  xLabel?: string;
  yLabel?: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Host-owned margins: the y title sits horizontally above the plot and the x title in a band
 * below it, so neither is rotated or clipped; tick counts follow the space each label needs.
 */
const functionPlotLayout = (
  spec: ReachFunctionPlotSpec,
  viewport: { width: number; height: number },
  typography: QuantitativeDisplayTypography,
): FunctionPlotLayout => {
  const { tick, title } = typography;
  const pad = Math.max(8, Math.round(Math.min(viewport.width, viewport.height) * 0.03));
  const xLabel = spec.axes.xLabel?.trim() || undefined;
  const yLabel = spec.axes.yLabel?.trim() || undefined;
  const count = (length: number, per: number) =>
    Math.min(10, Math.max(2, Math.floor(length / per)));
  const widest = (ticks: readonly number[]) =>
    Math.max(0, ...ticks.map((value) => estimateTextWidth(formatTick(value), tick)));
  const [x0, x1] = spec.viewport.x;
  const [y0, y1] = spec.viewport.y;
  const top = pad + (yLabel ? title * 1.35 : 0) + tick * 0.7;
  const bottom = pad + tick * 1.5 + (xLabel ? title * 1.35 : 0);
  const height = viewport.height - top - bottom;
  const yTicks = niceTicks(y0, y1, count(height, tick * 2.2));
  const left = pad + widest(yTicks) + tick * 0.6;
  const provisionalX = niceTicks(x0, x1, 10);
  const right = pad + Math.max(tick * 0.6, widest(provisionalX) / 2 + tick * 0.3);
  const width = viewport.width - left - right;
  if (width < 80 || height < 60) {
    throw new Error('Function plot viewport is too small for its labels.');
  }
  const xTicks = niceTicks(x0, x1, count(width, widest(provisionalX) + tick * 2));
  return {
    viewport,
    typography,
    pad,
    plot: { left: round2(left), top: round2(top), width: round2(width), height: round2(height) },
    xTicks,
    yTicks,
    ...(xLabel === undefined ? {} : { xLabel }),
    ...(yLabel === undefined ? {} : { yLabel }),
  };
};

const appendAxisTitles = (
  document: Document,
  svg: SVGSVGElement,
  chart: Chart,
  layout: FunctionPlotLayout,
  colors: Record<ReachFunctionPlotColorToken, string>,
): void => {
  const { pad, plot, viewport, typography } = layout;
  const append = (
    axis: 'x' | 'y',
    content: string,
    x: number,
    y: number,
    anchor: 'start' | 'end',
  ) => {
    const text = document.createElementNS(SVG_NAMESPACE, 'text');
    text.setAttribute('class', `reach-axis-title ${axis}`);
    text.setAttribute('x', String(round2(x)));
    text.setAttribute('y', String(round2(y)));
    text.setAttribute('font-size', String(typography.title));
    text.setAttribute('fill', colors.ink);
    text.setAttribute('text-anchor', anchor);
    text.textContent = content;
    svg.append(text);
  };
  if (layout.yLabel !== undefined) {
    // Horizontal, just right of the (sticky) y axis, in the band above the plot.
    const zero = chart.meta.xScale?.(0);
    const axisX = plot.left + Math.min(plot.width, Math.max(0, Number.isFinite(zero) ? zero! : 0));
    const width = estimateTextWidth(layout.yLabel, typography.title);
    const x = Math.max(pad, Math.min(viewport.width - pad - width, axisX + typography.tick * 0.4));
    append('y', layout.yLabel, x, pad + typography.title * 0.95, 'start');
  }
  if (layout.xLabel !== undefined)
    append(
      'x',
      layout.xLabel,
      viewport.width - pad,
      viewport.height - pad - typography.title * 0.25,
      'end',
    );
};

interface PreparedFunctionPlot {
  startedAt: number;
  width: number;
  height: number;
  background: string;
  colors: Record<ReachFunctionPlotColorToken, string>;
  compiled: ReturnType<typeof compileReachFunctionPlotSeries>;
  layout: FunctionPlotLayout;
  /** Sanitized, not yet outlined SVG. */
  svg: string;
  /** Data → logical px, identical to the chart's own scales plus the host canvas offset. */
  project: { x(value: number): number; y(value: number): number };
}

const prepareFunctionPlotSvg = async (
  input: ReachFunctionPlotRenderInput,
): Promise<PreparedFunctionPlot> => {
  const startedAt = performance.now();
  const width = assertDimension(input.width, REACH_FUNCTION_PLOT_RENDER_LIMITS.width, 'width');
  const height = assertDimension(input.height, REACH_FUNCTION_PLOT_RENDER_LIMITS.height, 'height');
  if (width * height > REACH_FUNCTION_PLOT_RENDER_LIMITS.maximumPixels) {
    throw new Error('Function plot pixel area is outside renderer limits.');
  }
  const background = input.background ?? DEFAULT_BACKGROUND;
  if (!HEX_COLOR.test(background)) throw new Error('Function plot background is invalid.');
  const colors = resolveColors(input.colors);
  const compiled = compileReachFunctionPlotSeries(input.spec, input.parameterValues, colors);
  const viewport = input.viewport ?? { width, height };
  if (
    ![viewport.width, viewport.height].every(
      (value) => Number.isFinite(value) && value >= 100 && value <= 4_096,
    )
  ) {
    throw new Error('Function plot viewport is outside renderer limits.');
  }
  const typography = input.typography ?? DEFAULT_TYPOGRAPHY;
  if (
    ![typography.tick, typography.title].every(
      (value) => Number.isFinite(value) && value >= 8 && value <= 96,
    )
  ) {
    throw new Error('Function plot typography is outside renderer limits.');
  }
  const layout = functionPlotLayout(compiled.spec, viewport, typography);
  const window = new Window({ url: 'http://localhost' });
  const restoreGlobals = installWindowGlobals(window);
  let svg: string;
  let project: PreparedFunctionPlot['project'];
  try {
    const target = window.document.createElement('div');
    window.document.body.append(target);
    const functionPlot = await resolveFunctionPlot();
    // function-plot reserves fixed 40/20/20/20 margins; size the chart so its inner plot equals
    // the host layout, then move the canvas into the host margins after drawing.
    const options: FunctionPlotOptions = {
      target: target as unknown as HTMLElement,
      width: layout.plot.width + 60,
      height: layout.plot.height + 40,
      disableZoom: true,
      grid: compiled.spec.axes.grid,
      xAxis: {
        domain: compiled.spec.viewport.x,
        position: 'sticky',
        type: 'linear',
      },
      yAxis: {
        domain: compiled.spec.viewport.y,
        position: 'sticky',
        type: 'linear',
      },
      data: compiled.series.map((series) =>
        series.kind === 'points'
          ? {
              attr:
                series.render === 'scatter' ? POINT_SCATTER_ATTRIBUTES : POINT_POLYLINE_ATTRIBUTES,
              fnType: 'points',
              graphType: series.render,
              points: series.points,
              skipTip: true,
              color: series.color,
            }
          : {
              fn: (scope) => series.evaluate(Number(scope.x)),
              fnType: 'linear',
              graphType: 'polyline',
              sampler: 'builtIn',
              nSamples: REACH_FUNCTION_PLOT_RENDER_LIMITS.samplesPerSeries,
              color: series.color,
              ...(series.domain === undefined ? {} : { range: series.domain }),
            },
      ),
    };
    const chart = functionPlot(options);
    const tickFormat = (value: { valueOf(): number }) => formatTick(Number(value));
    // When both axes pass through the origin, one "0" (on the x axis) labels it for both.
    const sharedOrigin = layout.xTicks.includes(0) && layout.yTicks.includes(0);
    chart.meta.xAxis?.tickValues(layout.xTicks).tickFormat(tickFormat);
    chart.meta.yAxis
      ?.tickValues(layout.yTicks)
      .tickFormat((value) => (sharedOrigin && Number(value) === 0 ? '' : tickFormat(value)));
    chart.draw();
    // The hover tip is hidden only through inline style, which sanitization strips; without
    // removal its circle paints a dot at the plot's top-left corner.
    for (const tip of [...target.querySelectorAll('g.tip')]) tip.remove();
    const svgElement = target.querySelector('svg') as unknown as SVGSVGElement | null;
    if (svgElement === null) throw new Error('Function plot renderer produced no SVG.');
    appendSemanticMarkers(
      window.document as unknown as Document,
      svgElement,
      chart,
      compiled.spec,
      compiled.functionSeries,
      typography.tick,
    );
    const canvas = svgElement.querySelector('g.canvas');
    if (canvas === null) throw new Error('Function plot renderer produced no canvas group.');
    canvas.setAttribute('transform', `translate(${layout.plot.left},${layout.plot.top})`);
    appendAxisTitles(window.document as unknown as Document, svgElement, chart, layout, colors);
    svgElement.setAttribute('role', 'img');
    svgElement.setAttribute('aria-label', compiled.spec.ariaLabel);
    for (const text of svgElement.querySelectorAll('text')) {
      text.setAttribute('font-family', FONT_FAMILY);
      if (text.closest('.axis')) text.setAttribute('font-size', String(typography.tick));
      const dy = text.getAttribute('dy');
      if (dy?.endsWith('em')) {
        const size = Number(inheritedSvgAttribute(text, 'font-size', '16'));
        text.setAttribute('dy', String(Number.parseFloat(dy) * size));
      }
    }
    for (const line of svgElement.querySelectorAll('path.line'))
      line.setAttribute('stroke-width', '3');
    svg = sanitizeSvgElement(svgElement, width, height, viewport);
    const xScale = chart.meta.xScale;
    const yScale = chart.meta.yScale;
    if (xScale === undefined || yScale === undefined) {
      throw new Error('Function plot renderer produced no finite coordinate scales.');
    }
    // Linear scales: freeze them as anchor pairs so no DOM-bound closure outlives the window.
    const [x0, x1] = compiled.spec.viewport.x;
    const [y0, y1] = compiled.spec.viewport.y;
    const px0 = xScale(x0);
    const px1 = xScale(x1);
    const py0 = yScale(y0);
    const py1 = yScale(y1);
    if (![px0, px1, py0, py1].every(Number.isFinite)) {
      throw new Error('Function plot renderer produced no finite coordinate scales.');
    }
    project = {
      x: (value) => layout.plot.left + px0 + ((value - x0) / (x1 - x0)) * (px1 - px0),
      y: (value) => layout.plot.top + py0 + ((value - y0) / (y1 - y0)) * (py1 - py0),
    };
  } finally {
    restoreGlobals();
    void window.close();
  }
  return { startedAt, width, height, background, colors, compiled, layout, svg, project };
};

interface RasterToolkit {
  Resvg: ResvgWasmModule['Resvg'];
  fontBuffers: Uint8Array[];
  font: Font;
}

const loadRasterToolkit = async (fontDirectoryInput?: string): Promise<RasterToolkit> => {
  await ensureResvgWasm();
  const { Resvg } = loadResvgWasmModule();
  const fontDirectory = await resolveReachFunctionPlotFontDirectory(fontDirectoryInput);
  const fontBuffers = await loadFontBuffers(fontDirectory);
  const font = create(
    Buffer.from(
      fontBuffers[REACH_FUNCTION_PLOT_REQUIRED_FONT_FILES.indexOf('SourceHanSans-VF.ttf')]!,
    ),
  ) as Font;
  return { Resvg, fontBuffers, font: font.getVariation({ wght: 400 }) };
};

type RenderedRaster = ReturnType<InstanceType<ResvgWasmModule['Resvg']>['render']>;

const rasterize = <T>(
  toolkit: RasterToolkit,
  outlinedSvg: string,
  target: Pick<PreparedFunctionPlot, 'background' | 'width' | 'height'>,
  read: (rendered: RenderedRaster) => T,
): T => {
  const renderer = new toolkit.Resvg(outlinedSvg, {
    background: target.background,
    fitTo: { mode: 'original' },
    font: {
      fontBuffers: toolkit.fontBuffers,
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
      sansSerifFamily: FONT_FAMILY,
    },
  });
  try {
    const rendered = renderer.render();
    try {
      if (rendered.width !== target.width || rendered.height !== target.height) {
        throw new Error('Function plot raster dimensions do not match the requested size.');
      }
      return read(rendered);
    } finally {
      rendered.free();
    }
  } finally {
    renderer.free();
  }
};

const renderLocked = async (
  input: ReachFunctionPlotRenderInput,
): Promise<ReachFunctionPlotRenderResult> => {
  const prepared = await prepareFunctionPlotSvg(input);
  const toolkit = await loadRasterToolkit(input.fontDirectory);
  const outlinedSvg = outlineSvgText(prepared.svg, toolkit.font);
  return rasterize(toolkit, outlinedSvg, prepared, (rendered) => {
    const png = rendered.asPng();
    if (
      png.byteLength === 0 ||
      png.byteLength > REACH_FUNCTION_PLOT_RENDER_LIMITS.maximumPngBytes ||
      !Buffer.from(png.subarray(0, 8)).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      throw new Error('Function plot raster output is invalid.');
    }
    if (
      performance.now() - prepared.startedAt >
      REACH_FUNCTION_PLOT_RENDER_LIMITS.maximumRenderMilliseconds
    ) {
      throw new Error('Function plot rendering exceeded its time budget.');
    }
    return {
      rendererVersion: REACH_FUNCTION_PLOT_RENDERER_VERSION,
      normalizedSpec: prepared.compiled.spec,
      png,
      pngSha256: createHash('sha256').update(png).digest('hex'),
      svg: prepared.svg,
      width: prepared.width,
      height: prepared.height,
    };
  });
};

const enqueueRender = <T>(render: () => Promise<T>): Promise<T> => {
  const result = renderQueue.then(render);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export const renderReachFunctionPlotPng = (
  input: ReachFunctionPlotRenderInput,
): Promise<ReachFunctionPlotRenderResult> => enqueueRender(() => renderLocked(input));

/* Tracer animation ------------------------------------------------------------------------- */

/** One completed Δx/Δy staircase step; both values are computed from the traced series. */
export interface ReachFunctionPlotAnimationStep {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dx: number;
  dy: number;
}

/** Host state of one frame; its pixels are a pure function of this state and the static plot. */
export interface ReachFunctionPlotAnimationFrameState {
  index: number;
  /** Frame start on the GIF clock in ms (sum of the previous delays). */
  startMs: number;
  x: number;
  y: number;
  /** Steps whose end the point has reached, in travel order. */
  steps: ReachFunctionPlotAnimationStep[];
}

export interface ReachFunctionPlotAnimationPlan {
  animation: ReachFunctionPlotAnimation;
  frameCount: number;
  /** Per-frame GIF delays in ms: multiples of 10 whose running sum tracks index / fps. */
  delaysMs: number[];
  frames: ReachFunctionPlotAnimationFrameState[];
}

type CompiledFunctionPlot = ReturnType<typeof compileReachFunctionPlotSeries>;

const tracerEvaluator = (
  compiled: CompiledFunctionPlot,
  seriesId: string,
): { evaluate: (x: number) => number; color: string } => {
  const series = compiled.series.find(({ id }) => id === seriesId);
  if (series === undefined) throw new Error(`Function plot tracer series ${seriesId} is missing.`);
  const [y0, y1] = compiled.spec.viewport.y;
  const tolerance = (y1 - y0) * 1e-9;
  const raw =
    series.kind === 'function'
      ? series.evaluate
      : (x: number): number => {
          const { points } = series;
          for (let index = 1; index < points.length; index += 1) {
            const [ax, ay] = points[index - 1]!;
            const [bx, by] = points[index]!;
            if (x >= ax && x <= bx) return x === bx ? by : ay + ((x - ax) / (bx - ax)) * (by - ay);
          }
          return Number.NaN;
        };
  return {
    color: series.color,
    evaluate: (x) => {
      const y = raw(x);
      if (!Number.isFinite(y) || y < y0 - tolerance || y > y1 + tolerance) {
        throw new Error(
          `Function plot tracer leaves viewport.y or its series is undefined at x=${formatTick(x)}.`,
        );
      }
      return y;
    },
  };
};

/** GIF delays are centiseconds: round the cumulative clock, not each frame, so drift never grows. */
const gifDelays = (frameCount: number, fps: number): number[] => {
  const clock = (index: number) => Math.round((index * 1000) / fps / 10) * 10;
  return Array.from({ length: frameCount }, (_, index) => clock(index + 1) - clock(index));
};

const planFromCompiled = (
  compiled: CompiledFunctionPlot,
  animation: ReachFunctionPlotAnimation,
): ReachFunctionPlotAnimationPlan => {
  const { tracer } = animation;
  const { evaluate } = tracerEvaluator(compiled, tracer.seriesId);
  const frameCount = reachFunctionPlotAnimationFrameCount(animation);
  const delaysMs = gifDelays(frameCount, animation.fps);
  const direction = Math.sign(tracer.xTo - tracer.xFrom);
  const span = Math.abs(tracer.xTo - tracer.xFrom);
  const allSteps: ReachFunctionPlotAnimationStep[] = [];
  if (tracer.stepMarks !== undefined) {
    const { every } = tracer.stepMarks;
    const count = Math.floor(span / every + 1e-9);
    for (let index = 0; index < count; index += 1) {
      const x0 = tracer.xFrom + direction * every * index;
      const x1 = tracer.xFrom + direction * every * (index + 1);
      const y0 = evaluate(x0);
      const y1 = evaluate(x1);
      allSteps.push({ x0, y0, x1, y1, dx: x1 - x0, dy: y1 - y0 });
    }
  }
  const epsilon = span * 1e-9;
  let startMs = 0;
  const frames = Array.from({ length: frameCount }, (_, index) => {
    // Constant x-speed; the first frame is the complete start state and the last reaches xTo.
    const x =
      index === frameCount - 1
        ? tracer.xTo
        : tracer.xFrom + (tracer.xTo - tracer.xFrom) * (index / (frameCount - 1));
    const frame: ReachFunctionPlotAnimationFrameState = {
      index,
      startMs,
      x,
      y: evaluate(x),
      steps: allSteps.filter((step) => direction * (x - step.x1) >= -epsilon),
    };
    startMs += delaysMs[index]!;
    return frame;
  });
  return { animation, frameCount, delaysMs, frames };
};

/** Validate an animation against its plot and compute every frame's state (no rasterization). */
export const planReachFunctionPlotAnimation = (
  specValue: unknown,
  animationValue: unknown,
  parameterValues?: Readonly<Record<string, number>>,
): ReachFunctionPlotAnimationPlan => {
  const compiled = compileReachFunctionPlotSeries(specValue, parameterValues);
  return planFromCompiled(
    compiled,
    parseReachFunctionPlotAnimationValue(animationValue, compiled.spec),
  );
};

export interface ReachFunctionPlotAnimationRenderInput extends ReachFunctionPlotRenderInput {
  animation: unknown;
}

export interface ReachFunctionPlotAnimationRenderResult {
  rendererVersion: typeof REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION;
  normalizedSpec: ReachFunctionPlotSpec;
  plan: ReachFunctionPlotAnimationPlan;
  gif: Uint8Array;
  gifSha256: string;
  width: number;
  height: number;
}

const escapeSvgText = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const formatCoordinate = (value: number): string => formatTick(Number(value.toFixed(2)));

/** Overlay markup of one frame in logical px, drawn above the static plot. */
const tracerOverlaySvg = (
  prepared: PreparedFunctionPlot,
  animation: ReachFunctionPlotAnimation,
  frame: ReachFunctionPlotAnimationFrameState,
  pointColor: string,
): string => {
  const { project, layout, colors } = prepared;
  const { tick } = layout.typography;
  const { width: viewWidth, height: viewHeight } = layout.viewport;
  const pad = layout.pad;
  const [vx0, vx1] = prepared.compiled.spec.viewport.x;
  const [vy0, vy1] = prepared.compiled.spec.viewport.y;
  const n = (value: number) => String(round2(value));
  const line = (ax: number, ay: number, bx: number, by: number, stroke: string, extra = '') =>
    `<line x1="${n(ax)}" y1="${n(ay)}" x2="${n(bx)}" y2="${n(by)}" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"${extra}/>`;
  const text = (content: string, x: number, y: number, anchor: 'start' | 'middle' | 'end') => {
    // Keep every label inside the drawing: shift horizontally, clamp the baseline vertically.
    const width = estimateTextWidth(content, tick);
    const left = anchor === 'start' ? x : anchor === 'end' ? x - width : x - width / 2;
    const shift = Math.max(pad - left, 0) - Math.max(left + width - (viewWidth - pad), 0);
    const baseline = Math.min(Math.max(y, pad + tick), viewHeight - pad);
    // A background halo keeps the moving label legible over grid lines, ticks and the curve.
    const halo = `<rect x="${n(left + shift - 4)}" y="${n(baseline - tick * 0.95)}" width="${n(width + 8)}" height="${n(tick * 1.25)}" fill="${prepared.background}" opacity="0.85"/>`;
    return `${halo}<text x="${n(x + shift)}" y="${n(baseline)}" font-size="${tick}" fill="${colors.ink}" text-anchor="${anchor}">${escapeSvgText(content)}</text>`;
  };
  const parts: string[] = [];
  const px = project.x(frame.x);
  const py = project.y(frame.y);
  if (animation.tracer.showProjections) {
    // Sticky axes sit at 0 when visible, otherwise at the nearest viewport edge.
    const axisX = project.x(Math.min(vx1, Math.max(vx0, 0)));
    const axisY = project.y(Math.min(vy1, Math.max(vy0, 0)));
    const dashed = ' stroke-dasharray="7 6" opacity="0.9"';
    parts.push(line(px, py, px, axisY, colors.muted, dashed));
    parts.push(line(px, py, axisX, py, colors.muted, dashed));
  }
  frame.steps.forEach((step, index) => {
    const ax = project.x(step.x0);
    const ay = project.y(step.y0);
    const bx = project.x(step.x1);
    const by = project.y(step.y1);
    parts.push(line(ax, ay, bx, ay, colors.warning));
    parts.push(line(bx, ay, bx, by, colors.success));
    if (index !== frame.steps.length - 1) return;
    // Label only the latest completed step so a long staircase stays readable.
    const below = step.dy >= 0 ? tick * 1.2 : -tick * 0.45;
    parts.push(text(`Δx=${formatTick(step.dx)}`, (ax + bx) / 2, ay + below, 'middle'));
    const right = step.dx >= 0;
    parts.push(
      text(
        `Δy=${formatTick(step.dy)}`,
        bx + (right ? tick * 0.45 : -tick * 0.45),
        (ay + by) / 2 + tick * 0.35,
        right ? 'start' : 'end',
      ),
    );
  });
  const radius = Math.max(6, Math.round(tick * 0.4));
  parts.push(
    `<circle cx="${n(px)}" cy="${n(py)}" r="${radius}" fill="${pointColor}" stroke="#ffffff" stroke-width="2.5"/>`,
  );
  if (animation.tracer.showCoordinates) {
    const label = `(${formatCoordinate(frame.x)}, ${formatCoordinate(frame.y)})`;
    const toLeft = px + radius + estimateTextWidth(label, tick) > viewWidth - pad;
    const above = py - radius - tick * 0.4;
    parts.push(
      text(
        label,
        toLeft ? px - radius - tick * 0.3 : px + radius + tick * 0.3,
        above < pad + tick ? py + radius + tick * 1.1 : above,
        toLeft ? 'end' : 'start',
      ),
    );
  }
  return `<g class="reach-function-plot-tracer">${parts.join('')}</g>`;
};

const outlineOverlay = (overlay: string, font: Font): string => {
  const outlined = outlineSvgText(`<svg xmlns="${SVG_NAMESPACE}">${overlay}</svg>`, font);
  return outlined.slice(outlined.indexOf('>') + 1, outlined.lastIndexOf('</svg>'));
};

const renderAnimationLocked = async (
  input: ReachFunctionPlotAnimationRenderInput,
): Promise<ReachFunctionPlotAnimationRenderResult> => {
  const prepared = await prepareFunctionPlotSvg(input);
  const animation = parseReachFunctionPlotAnimationValue(input.animation, prepared.compiled.spec);
  const plan = planFromCompiled(prepared.compiled, animation);
  const { width, height } = prepared;
  if (
    width > CODE_MEDIA_LIMITS.gifWidth ||
    height > CODE_MEDIA_LIMITS.gifHeight ||
    width * height * plan.frameCount > CODE_MEDIA_LIMITS.decodedFramePixels
  ) {
    throw new Error('Function plot GIF size or decoded frame budget exceeded.');
  }
  const { color } = tracerEvaluator(prepared.compiled, animation.tracer.seriesId);
  const toolkit = await loadRasterToolkit(input.fontDirectory);
  const base = outlineSvgText(prepared.svg, toolkit.font);
  const close = base.lastIndexOf('</svg>');
  const frameBytes = width * height * 4;
  const pixels = Buffer.alloc(frameBytes * plan.frameCount);
  for (const frame of plan.frames) {
    const overlay = outlineOverlay(
      tracerOverlaySvg(prepared, animation, frame, color),
      toolkit.font,
    );
    rasterize(toolkit, base.slice(0, close) + overlay + base.slice(close), prepared, (rendered) => {
      const rgba = rendered.pixels;
      if (rgba.byteLength !== frameBytes) throw new Error('Function plot frame size is invalid.');
      pixels.set(rgba, frame.index * frameBytes);
    });
    if (
      performance.now() - prepared.startedAt >
      REACH_FUNCTION_PLOT_ANIMATION_RENDER_LIMITS.maximumRenderMilliseconds
    ) {
      throw new Error('Function plot animation exceeded its time budget.');
    }
  }
  const gif = await sharp(pixels, {
    raw: { width, height: height * plan.frameCount, channels: 4, pageHeight: height },
    limitInputPixels: CODE_MEDIA_LIMITS.decodedFramePixels,
  })
    .gif({ delay: plan.delaysMs, loop: 0, dither: 0 })
    .toBuffer();
  if (
    gif.byteLength === 0 ||
    gif.byteLength > REACH_FUNCTION_PLOT_ANIMATION_RENDER_LIMITS.maximumGifBytes
  ) {
    throw new Error('Function plot GIF output size is invalid.');
  }
  return {
    rendererVersion: REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION,
    normalizedSpec: prepared.compiled.spec,
    plan,
    gif: new Uint8Array(gif),
    gifSha256: createHash('sha256').update(gif).digest('hex'),
    width,
    height,
  };
};

/** Render a tracer animation to a looping GIF; shares the serialized queue with PNG renders. */
export const renderReachFunctionPlotGif = (
  input: ReachFunctionPlotAnimationRenderInput,
): Promise<ReachFunctionPlotAnimationRenderResult> =>
  enqueueRender(() => renderAnimationLocked(input));
