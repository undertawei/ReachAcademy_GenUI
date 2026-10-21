import {
  acquireDeckChromium,
  deckChromiumLaunchOptions,
  launchDeckChromium,
} from './code-media-policy.js';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import { chromium, type Browser } from 'playwright-core';
import { loadHtmlLayoutFonts } from './html-layout/fonts.js';
import { withAbort } from './reference-image-download.js';
import sharp from 'sharp';
import {
  estimateTextWidth,
  formatTick,
  niceDomainTicks,
  type QuantitativeDisplayTypography,
} from './quantitative-display.js';

export const DIAGRAM_RENDERER_VERSION = 'static-diagram/v3';
export function validateStaticDiagram(source: string): string {
  if (Buffer.byteLength(source) > 180000) throw new Error('Diagram source exceeds budget');
  const tree = parse(source);
  let count = 0;
  const tags = new Set(
    'html head body style div span p br b strong i em svg g path rect circle ellipse line polyline polygon text tspan defs marker linearGradient radialGradient stop clipPath mask title desc'
      .toLowerCase()
      .split(' '),
  );
  const visit = (node: any) => {
    if (++count > 1200) throw new Error('Diagram DOM budget exceeded');
    if (node.tagName && !tags.has(node.tagName.toLowerCase()))
      throw new Error('Unsupported diagram tag: ' + node.tagName);
    for (const a of node.attrs ?? []) {
      if (
        /^on/i.test(a.name) ||
        ['href', 'src', 'srcset', 'action', 'formaction'].includes(a.name.toLowerCase())
      )
        throw new Error('External or executable diagram attribute');
      if (/javascript:|expression\s*\(|@import|animation|transition|behavior\s*:|\\/i.test(a.value))
        throw new Error('Executable or animated diagram style');
      for (const m of a.value.matchAll(/url\s*\(([^)]*)\)/gi))
        if (!/^['"]?#[\w-]+['"]?$/.test(m[1]!.trim())) throw new Error('External diagram resource');
    }
    if (node.tagName === 'style') {
      const css = (node.childNodes ?? []).map((x: any) => x.value ?? '').join('');
      if (/@import|animation|transition|expression\s*\(|javascript:|\\/i.test(css))
        throw new Error('Unsafe diagram CSS');
      for (const m of css.matchAll(/url\s*\(([^)]*)\)/gi))
        if (!/^['"]?#[\w-]+['"]?$/.test(m[1]!.trim()))
          throw new Error('External diagram CSS resource');
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(tree);
  return source;
}

export interface StaticDiagramInput {
  source: string;
  width: number;
  height: number;
  signal?: AbortSignal;
}

export async function renderStaticDiagram(input: StaticDiagramInput) {
  return (await renderStaticDiagramBatch([input], input.signal))[0]!;
}

/** 严格调用保留整批拒绝约定；生成管线使用逐图结果接口。 */
export async function renderStaticDiagramBatch(
  inputs: readonly StaticDiagramInput[],
  parentSignal?: AbortSignal,
) {
  for (const input of inputs) validateStaticDiagramInput(input);
  const outcomes = await renderStaticDiagramBatchWithPolicy(inputs, parentSignal, true);
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}

function validateStaticDiagramInput(input: StaticDiagramInput): void {
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    Math.min(input.width, input.height) < 240 ||
    Math.max(input.width, input.height) > 2048
  )
    throw new Error('Diagram dimensions exceed budget');
  validateStaticDiagram(input.source);
}

/** 同页只占用一个浏览器，每图独立上下文并保留各自的失败结果。 */
export async function renderStaticDiagramBatchSettled(
  inputs: readonly StaticDiagramInput[],
  parentSignal?: AbortSignal,
): Promise<PromiseSettledResult<Awaited<ReturnType<typeof renderDiagramInBrowser>>>[]> {
  return renderStaticDiagramBatchWithPolicy(inputs, parentSignal, false);
}

/** 两个接口共享浏览器生命周期；严格调用遇到首个渲染失败就停止后续图示。 */
async function renderStaticDiagramBatchWithPolicy(
  inputs: readonly StaticDiagramInput[],
  parentSignal: AbortSignal | undefined,
  stopOnFailure: boolean,
): Promise<PromiseSettledResult<Awaited<ReturnType<typeof renderDiagramInBrowser>>>[]> {
  if (inputs.length > 4) throw new Error('Diagram batch exceeds page asset budget');
  if (!inputs.length) return [];
  // 排队等槽位只受调用方信号约束，60 秒预算从拿到槽位才开始计时。
  const queueSignals = [
    ...(parentSignal ? [parentSignal] : []),
    ...inputs.flatMap((input) => (input.signal ? [input.signal] : [])),
  ];
  const release = await acquireDeckChromium(
    queueSignals.length ? AbortSignal.any(queueSignals) : undefined,
  );
  let active:
    | Promise<PromiseSettledResult<Awaited<ReturnType<typeof renderDiagramInBrowser>>>[]>
    | undefined;
  try {
    const expiresAt = Date.now() + 60000;
    const deadline = AbortSignal.any([...queueSignals, AbortSignal.timeout(60000)]);
    deadline.throwIfAborted();
    active = (async () => {
      const browser = await launchDeckChromium(() =>
        chromium.launch({
          ...deckChromiumLaunchOptions(),
          timeout: Math.max(1, Math.min(30000, expiresAt - Date.now())),
        }),
      );
      const stop = () => void browser.close().catch(() => undefined);
      deadline.addEventListener('abort', stop, { once: true });
      try {
        const results: PromiseSettledResult<Awaited<ReturnType<typeof renderDiagramInBrowser>>>[] =
          [];
        for (const input of inputs) {
          deadline.throwIfAborted();
          try {
            validateStaticDiagramInput(input);
            results.push({
              status: 'fulfilled',
              value: await renderDiagramInBrowser(browser, input, deadline),
            });
          } catch (reason) {
            deadline.throwIfAborted();
            if (stopOnFailure) throw reason;
            results.push({ status: 'rejected', reason });
          }
        }
        return results;
      } finally {
        deadline.removeEventListener('abort', stop);
        await browser.close();
      }
    })();
    return await withAbort(active, deadline);
  } catch (error) {
    // 排队取消立即结束，执行中取消等待上下文与浏览器清理完成。
    await active?.catch(() => undefined);
    throw error;
  } finally {
    release();
  }
}

async function renderDiagramInBrowser(
  browser: Browser,
  input: StaticDiagramInput,
  signal: AbortSignal,
) {
  const source = input.source;
  const fontCss = await loadHtmlLayoutFonts(source);
  signal.throwIfAborted();
  const context = await browser.newContext({
    viewport: { width: input.width, height: input.height },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    acceptDownloads: false,
    javaScriptEnabled: false,
  });
  try {
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html><head><style>' +
        fontCss +
        '\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:"Source Han Sans VF",sans-serif}body>svg{display:block}svg{max-width:100%;max-height:100%}</style></head><body>' +
        source +
        '</body></html>',
      { timeout: 15000 },
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const metrics = await page.evaluate(() => ({
      width: document.body.scrollWidth,
      height: document.body.scrollHeight,
      visible: Array.from(document.body.querySelectorAll('svg,div,text,p,span')).some((x) => {
        const r = x.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }),
    }));
    if (!metrics.visible || metrics.width > input.width + 2 || metrics.height > input.height + 2)
      throw new Error('Diagram empty or overflowing');
    const labelIssue = await page.evaluate(() => {
      // Hit testing must describe painted content, independent of model interaction CSS.
      for (const item of Array.from(document.body.querySelectorAll('*')))
        (item as HTMLElement).style.setProperty(
          'pointer-events',
          item instanceof SVGElement ? 'visiblePainted' : 'auto',
          'important',
        );
      const colorCanvas = document.createElement('canvas');
      colorCanvas.width = colorCanvas.height = 1;
      const colorContext = colorCanvas.getContext('2d')!;
      const alphas = new Map<string, number>();
      const opacities = new Map<Element, number>();
      // Method syntax keeps this callback self-contained when tsx preserves function names.
      // Named local arrow functions would reference its Node-side __name helper in Chromium.
      const paint = {
        alpha(color: string): number {
          if (color === 'none') return 0;
          const cached = alphas.get(color);
          if (cached !== undefined) return cached;
          colorContext.clearRect(0, 0, 1, 1);
          colorContext.fillStyle = 'transparent';
          colorContext.fillStyle = color;
          colorContext.fillRect(0, 0, 1, 1);
          const value = colorContext.getImageData(0, 0, 1, 1).data[3]! / 255;
          alphas.set(color, value);
          return value;
        },
        opacity(element: Element): number {
          const cached = opacities.get(element);
          if (cached !== undefined) return cached;
          const style = getComputedStyle(element);
          const value =
            style.display === 'none' || style.visibility !== 'visible'
              ? 0
              : Number(style.opacity) *
                (element.parentElement ? paint.opacity(element.parentElement) : 1);
          opacities.set(element, value);
          return value;
        },
        paintedAt(hit: Element, x: number, y: number): boolean {
          const effectiveOpacity = paint.opacity(hit);
          if (effectiveOpacity < 0.5) return false;
          const painted = getComputedStyle(hit);
          if (hit instanceof SVGGraphicsElement) {
            const fillAlpha =
              paint.alpha(painted.fill) * Number(painted.fillOpacity) * effectiveOpacity;
            const strokeAlpha =
              paint.alpha(painted.stroke) * Number(painted.strokeOpacity) * effectiveOpacity;
            if (hit instanceof SVGGeometryElement) {
              const matrix = hit.getScreenCTM();
              if (!matrix) return false;
              const point = new DOMPoint(x, y).matrixTransform(matrix.inverse());
              const strokeScale = Math.min(
                Math.hypot(matrix.a, matrix.b),
                Math.hypot(matrix.c, matrix.d),
              );
              return (
                (fillAlpha >= 0.5 && hit.isPointInFill(point)) ||
                (strokeAlpha >= 0.5 &&
                  parseFloat(painted.strokeWidth) * strokeScale >= 3 &&
                  hit.isPointInStroke(point))
              );
            }
            return ['text', 'tspan'].includes(hit.localName) && fillAlpha >= 0.5;
          }
          if (paint.alpha(painted.backgroundColor) * effectiveOpacity >= 0.5) return true;
          if (painted.backgroundImage !== 'none') {
            // Computed gradient stops serialize to rgb()/rgba(); unknown paint is conservative.
            const colors = painted.backgroundImage.match(/rgba?\([^)]*\)/g);
            if (!colors || colors.some((color) => paint.alpha(color) * effectiveOpacity >= 0.5))
              return true;
          }
          const bounds = hit.getBoundingClientRect();
          for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
            const width = parseFloat(painted[`border${side}Width`]);
            const within =
              side === 'Top'
                ? y <= bounds.top + width
                : side === 'Bottom'
                  ? y >= bounds.bottom - width
                  : side === 'Left'
                    ? x <= bounds.left + width
                    : x >= bounds.right - width;
            if (
              width > 0 &&
              within &&
              paint.alpha(painted[`border${side}Color`]) * effectiveOpacity >= 0.5
            )
              return true;
          }
          if (paint.alpha(painted.color) * effectiveOpacity < 0.5) return false;
          for (const text of Array.from(hit.childNodes)) {
            if (text.nodeType !== Node.TEXT_NODE || !text.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(text);
            if (
              Array.from(range.getClientRects()).some(
                (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
              )
            )
              return true;
          }
          return false;
        },
      };
      let glyphSamples = 0;
      for (const element of Array.from(document.body.querySelectorAll('*'))) {
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          paint.opacity(element) === 0
        )
          continue;
        if (
          ['defs', 'style', 'title', 'desc'].includes(element.localName) ||
          element.closest('defs')
        )
          continue;
        const texts = Array.from(element.childNodes).filter(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        if (!texts.length) continue;
        const transform = element instanceof SVGGraphicsElement ? element.getScreenCTM() : null;
        const scale = transform
          ? Math.min(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d))
          : 1;
        if (parseFloat(style.fontSize) * scale < 18) return 'Diagram label is below 18px';
        for (const node of texts) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const bounds = range.getBoundingClientRect();
          if (
            bounds.left < -2 ||
            bounds.top < -2 ||
            bounds.right > innerWidth + 2 ||
            bounds.bottom > innerHeight + 2
          )
            return 'Diagram label is clipped';
          // Sample individual glyph boxes, not the whole label rectangle: a partly
          // hidden label must fail even when its unobstructed half remains readable.
          const content = node.textContent ?? '';
          for (let index = 0; index < content.length; index++) {
            if (!content[index]?.trim()) continue;
            if (++glyphSamples > 20000) return 'Diagram label sampling budget exceeded';
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const glyph = range.getBoundingClientRect();
            if (glyph.width < 1 || glyph.height < 1) continue;
            const x = glyph.left + glyph.width / 2;
            const y = glyph.top + glyph.height / 2;
            const stack = document.elementsFromPoint(x, y);
            const ownIndex = stack.findIndex((hit) => hit === element || element.contains(hit));
            if (ownIndex < 0) continue;
            const covering = stack.slice(0, ownIndex).find((hit) => {
              if (hit.contains(element) || element.contains(hit)) return false;
              return paint.paintedAt(hit, x, y);
            });
            if (covering) return 'Diagram label is obscured by another shape';
          }
        }
      }
      return null;
    });
    if (labelIssue) throw new Error(labelIssue);
    const bytes = await page.screenshot({ type: 'png', omitBackground: true, timeout: 15000 });
    signal.throwIfAborted();
    // Alpha carries the contrast of black ink on a transparent canvas. Dropping it
    // would incorrectly classify a visible black-only diagram as an empty image.
    const stats = await sharp(bytes).stats();
    if (stats.channels.every((channel) => channel.stdev < 0.5))
      throw new Error('Diagram has no visible painted content');
    return {
      bytes,
      contentType: 'image/png' as const,
      sourceDigest: createHash('sha256').update(source).digest('hex'),
    };
  } finally {
    await context.close();
  }
}
/** Cache identity of the host chart layout; bump whenever chart pixels may change. */
export const CHART_DIAGRAM_RENDERER_VERSION = 'chart-svg/v2';

export interface ChartSvgOptions {
  /** Logical coordinate system (displayed px). Defaults to the raster width/height. */
  viewport?: { width: number; height: number };
  /** Text sizes in logical px; defaults scale with the viewport and never drop below 18. */
  typography?: QuantitativeDisplayTypography;
}

const CHART_INK = '#172033';
const CHART_MUTED = '#475569';
const CHART_GRID = '#e2e8f0';
const CHART_AXIS = '#94a3b8';
const CHART_BAR = '#2563eb';
const CHART_COLORS = ['#2563eb', '#0891b2', '#7c3aed', '#0d9488', '#d97706', '#64748b'];
/** CJK and other wide glyphs break anywhere; other text breaks between words. */
const CHART_LABEL_TOKENS = /[⺀-￿]|[^\s⺀-￿]+|\s+/g;

const escapeChartText = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
const chartNumber = (value: number) => String(Math.round(value * 100) / 100);

function chartText(
  x: number,
  y: number,
  content: string,
  size: number,
  options: {
    anchor?: 'start' | 'middle' | 'end';
    fill?: string;
    weight?: number;
    role?: string;
  } = {},
): string {
  return (
    '<text' +
    (options.role ? ' data-chart-role="' + options.role + '"' : '') +
    ' x="' +
    chartNumber(x) +
    '" y="' +
    chartNumber(y) +
    '" font-size="' +
    size +
    '"' +
    (options.anchor && options.anchor !== 'start' ? ' text-anchor="' + options.anchor + '"' : '') +
    (options.fill ? ' fill="' + options.fill + '"' : '') +
    (options.weight ? ' font-weight="' + options.weight + '"' : '') +
    '>' +
    escapeChartText(content) +
    '</text>'
  );
}

function chartLine(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1) {
  return (
    '<line x1="' +
    chartNumber(x1) +
    '" y1="' +
    chartNumber(y1) +
    '" x2="' +
    chartNumber(x2) +
    '" y2="' +
    chartNumber(y2) +
    '" stroke="' +
    stroke +
    '" stroke-width="' +
    width +
    '"/>'
  );
}

/**
 * Greedy wrap into at most maxLines lines of maxWidth. `complete` is false when the text had to
 * be ellipsized to fit.
 */
function wrapChartLabel(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number,
): { lines: string[]; complete: boolean } {
  const lines: string[] = [];
  let current = '';
  for (const token of text.trim().match(CHART_LABEL_TOKENS) ?? []) {
    const blank = /^\s+$/.test(token);
    if (!current) {
      if (!blank) current = token;
      continue;
    }
    if (estimateTextWidth((current + token).trimEnd(), size) <= maxWidth) {
      current += token;
      continue;
    }
    lines.push(current.trimEnd());
    current = blank ? '' : token;
  }
  if (current.trim()) lines.push(current.trimEnd());
  if (!lines.length) return { lines: [''], complete: true };
  const complete =
    lines.length <= maxLines && lines.every((line) => estimateTextWidth(line, size) <= maxWidth);
  if (complete) return { lines, complete };
  const kept = lines.slice(0, maxLines);
  let last = [...kept.at(-1)!];
  while (last.length > 1 && estimateTextWidth(last.join('') + '…', size) > maxWidth) last.pop();
  kept[kept.length - 1] = last.join('').trimEnd() + '…';
  return { lines: kept, complete: false };
}

/**
 * Deterministic chart SVG. `width`/`height` are the raster size; drawing happens in the logical
 * viewport so text sizes stay in displayed px when the raster is a device-scaled slot render.
 * Bar charts carry a value axis with nice ticks and gridlines, and few categories keep moderate
 * bar thickness instead of thin bars in an empty canvas. Category labels that fit their column
 * on two lines give vertical columns; longer labels switch to horizontal bars with a wrapped
 * label column.
 */
export function renderChartSvg(
  spec: {
    type: 'bar' | 'pie';
    labels: string[];
    values: number[];
    title?: string;
    valueLabel?: string;
  },
  width: number,
  height: number,
  options: ChartSvgOptions = {},
): string {
  const W = options.viewport?.width ?? width;
  const H = options.viewport?.height ?? height;
  const tick = options.typography?.tick ?? Math.max(18, Math.round(Math.min(W, H) / 36));
  const titleSize = options.typography?.title ?? Math.round(tick * 1.25);
  const pad = Math.max(12, Math.round(Math.min(W, H) * 0.04));
  const parts: string[] = [];
  let top = pad;
  if (spec.title) {
    const { lines } = wrapChartLabel(spec.title, W - 2 * pad, titleSize, 2);
    lines.forEach((line, index) =>
      parts.push(
        chartText(pad, top + titleSize * (0.9 + index * 1.25), line, titleSize, {
          weight: 600,
          role: 'title',
        }),
      ),
    );
    top += titleSize * 1.25 * lines.length + tick * 0.4;
  }
  parts.push(
    spec.type === 'bar'
      ? renderBarChart(spec, W, H, top, pad, tick, titleSize)
      : renderPieChart(spec, W, H, top, pad, tick),
  );
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    width +
    '" height="' +
    height +
    '" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '"><rect width="100%" height="100%" fill="#fff"/><g fill="' +
    CHART_INK +
    '">' +
    parts.join('') +
    '</g></svg>'
  );
}

function renderBarChart(
  spec: { labels: string[]; values: number[]; valueLabel?: string },
  W: number,
  H: number,
  initialTop: number,
  pad: number,
  tick: number,
  titleSize: number,
): string {
  const values = spec.values;
  const n = values.length;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const hasNegative = values.some((value) => value < 0);
  const hasPositive = !hasNegative || values.some((value) => value > 0);
  const dataRoom = tick * 1.5;
  const tickCount = (length: number, per: number) =>
    Math.min(6, Math.max(2, Math.floor(length / per)));
  const widest = (numbers: readonly number[]) =>
    Math.max(...numbers.map((value) => estimateTextWidth(formatTick(value), tick)));
  const valueTitleHeight = spec.valueLabel ? titleSize * 1.3 : 0;
  const out: string[] = [];
  let top = initialTop;

  // Vertical columns when every category label fits its column on at most two lines.
  const provisionalTicks = niceDomainTicks(
    min,
    max,
    tickCount(H - top - pad - valueTitleHeight - tick * 3 - dataRoom, tick * 2.4),
  );
  const left = pad + widest(provisionalTicks) + tick * 0.5;
  const plotRight = W - pad;
  const band = (plotRight - left) / n;
  const vertical = spec.labels.map((label) => wrapChartLabel(label, band * 0.94, tick, 2));
  if (vertical.every((label) => label.complete)) {
    if (spec.valueLabel) {
      out.push(
        chartText(pad, top + titleSize * 0.9, spec.valueLabel, titleSize, {
          fill: CHART_MUTED,
          role: 'value-title',
        }),
      );
      top += valueTitleHeight;
    }
    const labelLines = Math.max(...vertical.map((label) => label.lines.length));
    const plotTop = top + (hasPositive ? dataRoom : tick * 0.6);
    const plotBottom =
      H - pad - labelLines * tick * 1.25 - tick * 0.4 - (hasNegative ? dataRoom : 0);
    const ticks = niceDomainTicks(min, max, tickCount(plotBottom - plotTop, tick * 2.4));
    const low = ticks[0]!;
    const high = ticks.at(-1)!;
    const scale = (value: number) =>
      plotBottom - ((value - low) / (high - low)) * (plotBottom - plotTop);
    const zero = scale(0);
    for (const value of ticks) {
      const y = scale(value);
      out.push(chartLine(left, y, plotRight, y, CHART_GRID));
      out.push(
        chartText(left - tick * 0.4, y + tick * 0.35, formatTick(value), tick, {
          anchor: 'end',
          fill: CHART_MUTED,
          role: 'tick',
        }),
      );
    }
    out.push(chartLine(left, plotTop, left, plotBottom, CHART_AXIS, 1.5));
    const barWidth = Math.min(band * 0.62, Math.max(tick * 2, (plotRight - left) * 0.2));
    const labelTop = plotBottom + (hasNegative ? dataRoom : 0) + tick * 0.4;
    values.forEach((value, index) => {
      const center = left + band * (index + 0.5);
      const end = scale(value);
      out.push(
        '<rect data-chart-role="bar" x="' +
          chartNumber(center - barWidth / 2) +
          '" y="' +
          chartNumber(Math.min(zero, end)) +
          '" width="' +
          chartNumber(barWidth) +
          '" height="' +
          chartNumber(Math.max(1, Math.abs(end - zero))) +
          '" fill="' +
          CHART_BAR +
          '"/>',
      );
      out.push(
        chartText(
          center,
          value < 0 ? end + tick * 1.15 : end - tick * 0.35,
          formatTick(value),
          tick,
          { anchor: 'middle', role: 'data' },
        ),
      );
      vertical[index]!.lines.forEach((line, lineIndex) =>
        out.push(
          chartText(center, labelTop + tick * (0.95 + lineIndex * 1.25), line, tick, {
            anchor: 'middle',
            role: 'category',
          }),
        ),
      );
    });
    out.push(chartLine(left, zero, plotRight, zero, CHART_AXIS, 1.5));
    return out.join('');
  }

  // Horizontal bars: wrapped category column on the left, value axis along the bottom.
  const labelWidth = Math.min(
    W * 0.32,
    Math.max(...spec.labels.map((label) => estimateTextWidth(label, tick))),
  );
  const horizontal = spec.labels.map((label) => wrapChartLabel(label, labelWidth, tick, 3));
  const dataWidth = widest(values);
  const plotLeft = pad + labelWidth + tick * 0.6 + (hasNegative ? dataWidth + tick * 0.4 : 0);
  const right = W - pad - (hasPositive ? dataWidth + tick * 0.4 : tick * 0.5);
  const plotTop = top + tick * 0.3;
  const plotBottom = H - pad - tick * 1.5 - valueTitleHeight;
  const ticks = niceDomainTicks(
    min,
    max,
    tickCount(right - plotLeft, widest([min, max]) + tick * 3),
  );
  const low = ticks[0]!;
  const high = ticks.at(-1)!;
  const scale = (value: number) => plotLeft + ((value - low) / (high - low)) * (right - plotLeft);
  const zero = scale(0);
  for (const value of ticks) {
    const x = scale(value);
    out.push(chartLine(x, plotTop, x, plotBottom, CHART_GRID));
    out.push(
      chartText(x, plotBottom + tick * 1.2, formatTick(value), tick, {
        anchor: 'middle',
        fill: CHART_MUTED,
        role: 'tick',
      }),
    );
  }
  out.push(chartLine(plotLeft, plotBottom, right, plotBottom, CHART_AXIS, 1.5));
  if (spec.valueLabel)
    out.push(
      chartText(right, H - pad - titleSize * 0.25, spec.valueLabel, titleSize, {
        anchor: 'end',
        fill: CHART_MUTED,
        role: 'value-title',
      }),
    );
  const step = (plotBottom - plotTop) / n;
  const barHeight = Math.min(step * 0.62, Math.max(tick * 1.6, (plotBottom - plotTop) * 0.2));
  values.forEach((value, index) => {
    const center = plotTop + step * (index + 0.5);
    const end = scale(value);
    out.push(
      '<rect data-chart-role="bar" x="' +
        chartNumber(Math.min(zero, end)) +
        '" y="' +
        chartNumber(center - barHeight / 2) +
        '" width="' +
        chartNumber(Math.max(1, Math.abs(end - zero))) +
        '" height="' +
        chartNumber(barHeight) +
        '" fill="' +
        CHART_BAR +
        '"/>',
    );
    out.push(
      chartText(
        value < 0 ? end - tick * 0.4 : end + tick * 0.4,
        center + tick * 0.35,
        formatTick(value),
        tick,
        { anchor: value < 0 ? 'end' : 'start', role: 'data' },
      ),
    );
    const lines = horizontal[index]!.lines;
    lines.forEach((line, lineIndex) =>
      out.push(
        chartText(
          pad,
          center + tick * (0.35 + (lineIndex - (lines.length - 1) / 2) * 1.25),
          line,
          tick,
          { role: 'category' },
        ),
      ),
    );
  });
  out.push(chartLine(zero, plotTop, zero, plotBottom, CHART_AXIS, 1.5));
  return out.join('');
}

function renderPieChart(
  spec: { labels: string[]; values: number[] },
  W: number,
  H: number,
  top: number,
  pad: number,
  tick: number,
): string {
  const total = spec.values.reduce((a, b) => a + b, 0);
  if (spec.values.some((x) => x < 0) || total <= 0)
    throw new Error('Pie chart requires positive total and nonnegative values');
  const available = H - top - pad;
  const r = Math.max(tick, Math.min(W * 0.22, available * 0.46));
  const cx = pad + r + tick * 0.5;
  const cy = top + available / 2;
  const legendX = cx + r + tick * 1.5;
  const legendWidth = W - pad - legendX - tick * 1.2;
  const row = Math.min(tick * 1.9, available / spec.values.length);
  const legendTop = cy - (row * spec.values.length) / 2;
  const out: string[] = [];
  let angle = -Math.PI / 2;
  spec.values.forEach((v, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length]!;
    const next = angle + (v / total) * 2 * Math.PI;
    if (v === total)
      out.push(
        '<circle cx="' +
          chartNumber(cx) +
          '" cy="' +
          chartNumber(cy) +
          '" r="' +
          chartNumber(r) +
          '" fill="' +
          color +
          '"/>',
      );
    else if (v > 0)
      out.push(
        '<path d="M ' +
          chartNumber(cx) +
          ' ' +
          chartNumber(cy) +
          ' L ' +
          chartNumber(cx + r * Math.cos(angle)) +
          ' ' +
          chartNumber(cy + r * Math.sin(angle)) +
          ' A ' +
          chartNumber(r) +
          ' ' +
          chartNumber(r) +
          ' 0 ' +
          (next - angle > Math.PI ? 1 : 0) +
          ' 1 ' +
          chartNumber(cx + r * Math.cos(next)) +
          ' ' +
          chartNumber(cy + r * Math.sin(next)) +
          ' Z" fill="' +
          color +
          '"/>',
      );
    angle = next;
    const y = legendTop + row * (i + 0.5);
    out.push(
      '<rect x="' +
        chartNumber(legendX) +
        '" y="' +
        chartNumber(y - tick * 0.4) +
        '" width="' +
        chartNumber(tick * 0.8) +
        '" height="' +
        chartNumber(tick * 0.8) +
        '" fill="' +
        color +
        '"/>',
    );
    const label =
      spec.labels[i]! + ' ' + formatTick(v) + ' (' + ((100 * v) / total).toFixed(1) + '%)';
    out.push(
      chartText(
        legendX + tick * 1.2,
        y + tick * 0.35,
        wrapChartLabel(label, legendWidth, tick, 1).lines[0]!,
        tick,
        { fill: color, role: 'data' },
      ),
    );
  });
  return out.join('');
}
