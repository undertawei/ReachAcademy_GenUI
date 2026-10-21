import {
  parseReachDeckDocumentV2,
  resolveDeckTheme,
  type ReachDeckNativeElementV2,
  type ReachDeckColorV2,
  type ReachDeckDocumentV2,
  type ReachDeckFillV2,
  type ReachDeckMediaResourceV2,
  type ReachDeckShapeElementV2,
  type ReachDeckStrokeV2,
  type ReachDeckTextFrameElementV2,
  type ReachDeckThemeResourceV2,
  type ReachDeckTransformV2,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';
import { toPng } from 'html-to-image';
import {
  createNodeWarning,
  extractRenderedScene,
  findSlideRoot,
  hasOnlyInlineTextChildren,
  isRenderedNodeVisible,
  validateRenderedScene,
  type ComputedNodeStyle,
  type HtmlDeckWarning,
  type HtmlDeckWarningCode,
  type RenderedNode,
  type RenderedTextStyle,
} from './renderedScene';

const STAGE = { width: 1600, height: 900 } as const;
const MAX_ELEMENTS = 80;
const MAX_HTML_LENGTH = 300_000;
const THEME_NAMES = new Set([
  'reach-classic',
  'deep-tech',
  'warm-study',
  'high-contrast-board',
  'evergreen-field',
]);
const PROHIBITED_ELEMENTS =
  'script,iframe,object,embed,link,base,form,input,button,textarea,select,video,audio,source';

export interface HtmlDeckCompileResult {
  document: ReachDeckDocumentV2;
  diagnostics: string[];
  warnings: HtmlDeckWarning[];
  elementCount: number;
  themeName: string;
  resourceUrlsById: Readonly<Record<string, string>>;
  telemetry: {
    fallbackCount: number;
    inferredElementCount: number;
    legacyElementCount: number;
    warningCounts: Partial<Record<HtmlDeckWarningCode, number>>;
  };
}

export type MeasureElement = (element: Element) => DOMRect;
export type RasterizeElement = (
  element: HTMLElement | SVGSVGElement,
  mode?: 'element' | 'background',
) => Promise<string | { dataUrl: string; bounds: RectLike }>;

const round = (value: number): number => Math.round(value * 100) / 100;

const stripFence = (source: string): string => {
  const trimmed = source.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
};

const removeCssUrls = (value: string): string =>
  value.replace(/@import\s+[^;]+;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none');

export function sanitizeGeneratedHtml(source: string): string {
  const unfenced = stripFence(source);
  if (!unfenced) throw new Error('生成结果中没有 HTML。');
  if (unfenced.length > MAX_HTML_LENGTH) throw new Error('生成的 HTML 超过 300 KB 限制。');

  const document = new DOMParser().parseFromString(unfenced, 'text/html');
  document.querySelectorAll(PROHIBITED_ELEMENTS).forEach((element) => element.remove());
  document.querySelectorAll('meta[http-equiv]').forEach((element) => element.remove());

  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const keepsInlineImage =
        name === 'src' &&
        element.tagName === 'IMG' &&
        /^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);/i.test(attribute.value);
      if (
        name.startsWith('on') ||
        name.startsWith('data-reach-math-') ||
        name === 'data-reach-text-autofit' ||
        name === 'href' ||
        name === 'srcset' ||
        (name === 'src' && !keepsInlineImage)
      ) {
        element.removeAttribute(attribute.name);
      } else if (name === 'style') {
        element.setAttribute('style', removeCssUrls(attribute.value));
      }
    }
  });
  document.querySelectorAll('style').forEach((element) => {
    element.textContent = removeCssUrls(element.textContent ?? '');
  });

  const root = findSlideRoot(document);
  if (!root) {
    const wrapper = document.createElement('section');
    wrapper.id = 'slide';
    wrapper.setAttribute('data-title', 'HTML Generated Slide');
    wrapper.setAttribute('data-theme', 'reach-classic');
    while (document.body.firstChild) wrapper.append(document.body.firstChild);
    document.body.append(wrapper);
  }

  const baseStyle = document.createElement('style');
  baseStyle.setAttribute('data-html-deck-base', '');
  baseStyle.textContent = `
    html, body { margin: 0 !important; width: ${STAGE.width}px !important; height: ${STAGE.height}px !important; overflow: hidden !important; }
    [data-deck-slide], #slide { position: relative; width: ${STAGE.width}px; height: ${STAGE.height}px; overflow: hidden; }
    [data-deck-slide] *, #slide * { box-sizing: border-box; }
  `;
  document.head.append(baseStyle);

  const csp = document.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute(
    'content',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; script-src 'none'",
  );
  document.head.prepend(csp);

  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

const uniqueId = (candidate: string, index: number, ids: Set<string>): string => {
  const base =
    candidate
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `element-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (ids.has(id)) id = `${base}-${suffix++}`;
  ids.add(id);
  return id;
};

type RectLike = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

const toTransform = (rect: RectLike, rootRect: RectLike): ReachDeckTransformV2 => ({
  x: round(((rect.left - rootRect.left) / rootRect.width) * STAGE.width),
  y: round(((rect.top - rootRect.top) / rootRect.height) * STAGE.height),
  width: round((rect.width / rootRect.width) * STAGE.width),
  height: round((rect.height / rootRect.height) * STAGE.height),
});

const hash = (value: string): string => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
};

const byteHex = (value: number): string =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');

const linearSrgbToByte = (value: number): number => {
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, encoded * 255));
};

const oklchToColor = (value: string): ReachDeckColorV2 | undefined => {
  const match = value.match(
    /^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+(-?[\d.]+)(deg|rad|turn)?(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/,
  );
  if (!match) return undefined;
  const lightness = Number.parseFloat(match[1]!) / (match[2] ? 100 : 1);
  const chroma = Number.parseFloat(match[3]!);
  const rawHue = Number.parseFloat(match[4]!);
  const hueDegrees =
    match[5] === 'rad' ? (rawHue * 180) / Math.PI : match[5] === 'turn' ? rawHue * 360 : rawHue;
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const red = linearSrgbToByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = linearSrgbToByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = linearSrgbToByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  const rawAlpha = match[6];
  const alpha =
    rawAlpha === undefined ? undefined : Number.parseFloat(rawAlpha) / (match[7] ? 100 : 1);
  return {
    kind: 'srgb',
    value: `#${byteHex(red)}${byteHex(green)}${byteHex(blue)}`,
    ...(alpha === undefined ? {} : { alpha: Math.min(1, Math.max(0, alpha)) }),
  };
};

const cssColor = (value: string): ReachDeckColorV2 | undefined => {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'transparent') {
    return { kind: 'srgb', value: '#000000', alpha: 0 };
  }
  const hex = normalized.match(/^#([a-f\d]{3,8})$/i)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [...hex].map((part) => `${part}${part}`);
      return {
        kind: 'srgb',
        value: `#${r}${g}${b}`,
        ...(a === undefined ? {} : { alpha: Number.parseInt(a, 16) / 255 }),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        kind: 'srgb',
        value: `#${hex.slice(0, 6)}`,
        ...(hex.length === 8 ? { alpha: Number.parseInt(hex.slice(6), 16) / 255 } : {}),
      };
    }
  }

  const rgb = normalized.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/,
  );
  if (rgb) {
    const alphaValue = rgb[4];
    const alpha = alphaValue?.endsWith('%')
      ? Number.parseFloat(alphaValue) / 100
      : alphaValue === undefined
        ? undefined
        : Number.parseFloat(alphaValue);
    return {
      kind: 'srgb',
      value: `#${byteHex(Number(rgb[1]))}${byteHex(Number(rgb[2]))}${byteHex(Number(rgb[3]))}`,
      ...(alpha === undefined ? {} : { alpha: Math.min(1, Math.max(0, alpha)) }),
    };
  }
  return oklchToColor(normalized);
};

const colorIsTransparent = (color: ReachDeckColorV2 | undefined): boolean => color?.alpha === 0;

const solidFillFromStyle = (style: ComputedNodeStyle): ReachDeckFillV2 | undefined => {
  if (style.backgroundImage && style.backgroundImage !== 'none') return undefined;
  const color = cssColor(style.backgroundColor);
  if (!color || colorIsTransparent(color)) return { kind: 'none' };
  return { kind: 'solid', color };
};

const borderStrokeFromStyle = (style: ComputedNodeStyle): ReachDeckStrokeV2 | undefined => {
  const widths = [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ].map((value) => Number.parseFloat(value));
  if (widths.some((value) => !Number.isFinite(value)) || new Set(widths).size !== 1)
    return undefined;
  const width = widths[0] ?? 0;
  if (width <= 0 || style.borderTopStyle === 'none') return undefined;
  if (
    style.borderTopStyle !== style.borderRightStyle ||
    style.borderTopStyle !== style.borderBottomStyle ||
    style.borderTopStyle !== style.borderLeftStyle ||
    style.borderTopColor !== style.borderRightColor ||
    style.borderTopColor !== style.borderBottomColor ||
    style.borderTopColor !== style.borderLeftColor
  ) {
    return undefined;
  }
  const fill = cssColor(style.borderTopColor);
  if (!fill || colorIsTransparent(fill)) return undefined;
  const dash =
    style.borderTopStyle === 'dotted'
      ? 'dot'
      : style.borderTopStyle === 'dashed'
        ? 'dash'
        : 'solid';
  return { width, fill, dash };
};

const shadowFromStyle = (
  style: ComputedNodeStyle,
): ReachDeckShapeElementV2['style']['effects'] | undefined => {
  const value = style.boxShadow.trim();
  if (!value || value === 'none' || value.includes('inset')) return undefined;
  const colorMatch = value.match(/(rgba?\([^)]*\)|#[a-f\d]{3,8})/i);
  if (!colorMatch) return undefined;
  const color = cssColor(colorMatch[1]!);
  if (!color) return undefined;
  const numbers = value
    .replace(colorMatch[0], '')
    .match(/-?[\d.]+px/g)
    ?.map((part) => Number.parseFloat(part));
  if (!numbers || numbers.length < 2 || (numbers[3] ?? 0) !== 0) return undefined;
  const [dx, dy, blur = 0] = numbers;
  return {
    shadow: {
      color,
      blur: Math.max(0, blur),
      distance: Math.hypot(dx!, dy!),
      angle: (Math.atan2(dy!, dx!) * 180) / Math.PI,
    },
  };
};

const cssNumber = (value: string): number | undefined => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const firstFontFamily = (value: string): string =>
  (value.split(',')[0] ?? value).trim().replace(/^['"]|['"]$/g, '') || 'Arial';

const resolvedFontWeight = (value: string): number => {
  if (value === 'normal') return 400;
  if (value === 'bold') return 700;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(900, Math.max(100, parsed)) : 400;
};

const textMarksFromStyle = (style: RenderedTextStyle): RichTextMark[] => {
  const attrs: Record<string, unknown> = {
    color: style.color,
    fontFamily: firstFontFamily(style.fontFamily),
    fontSize: style.fontSize,
    fontWeight: resolvedFontWeight(style.fontWeight),
  };
  const letterSpacing = cssNumber(style.letterSpacing);
  const lineHeight = cssNumber(style.lineHeight ?? '');
  if (lineHeight !== undefined && lineHeight > 0) attrs.lineHeightPx = lineHeight;
  if (letterSpacing !== undefined && letterSpacing !== 0) attrs.letterSpacing = letterSpacing;
  if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
    attrs.backgroundColor = style.backgroundColor;
  }

  const marks: RichTextMark[] = [{ type: 'textStyle', attrs }];
  if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') marks.push({ type: 'italic' });
  if (style.textDecorationLine.includes('underline')) marks.push({ type: 'underline' });
  if (style.textDecorationLine.includes('line-through')) marks.push({ type: 'strike' });
  return marks;
};

const richTextFromRenderedNode = (node: RenderedNode): RichTextDocument => {
  const content: RichTextNode[] = node.textRuns.map((run) =>
    run.type === 'break'
      ? { type: 'hardBreak' }
      : run.type === 'math'
        ? {
            type: run.display ? 'blockMath' : 'inlineMath',
            attrs: {
              latex: run.latex,
              fontSize: cssNumber(run.style.fontSize),
              lineHeightPx: cssNumber(run.style.lineHeight ?? ''),
              color: run.style.color,
            },
          }
        : { type: 'text', text: run.text, marks: textMarksFromStyle(run.style) },
  );
  const lineHeight = cssNumber(node.style.lineHeight);
  const textAlign = node.style.textAlign;
  const paragraphAttrs: Record<string, unknown> = {};
  const fontSize = cssNumber(node.style.fontSize);
  if (fontSize !== undefined && fontSize > 0) paragraphAttrs.fontSize = fontSize;
  if (lineHeight !== undefined && lineHeight > 0) paragraphAttrs.lineHeightPx = lineHeight;
  if (
    textAlign === 'left' ||
    textAlign === 'center' ||
    textAlign === 'right' ||
    textAlign === 'justify'
  ) {
    paragraphAttrs.textAlign = textAlign;
  }

  const blocks: RichTextNode[] = [];
  let inline: RichTextNode[] = [];
  const flush = () => {
    if (!inline.length) return;
    blocks.push({
      type: 'paragraph',
      ...(Object.keys(paragraphAttrs).length ? { attrs: paragraphAttrs } : {}),
      content: inline,
    });
    inline = [];
  };
  for (const child of content) {
    if (child.type === 'blockMath') {
      flush();
      blocks.push(child);
    } else inline.push(child);
  }
  flush();
  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
};

const verticalAlignmentFromStyle = (
  style: ComputedNodeStyle | undefined,
): 'top' | 'middle' | 'bottom' => {
  if (!style || !style.display.includes('flex')) return 'top';
  const alignment = style.flexDirection.startsWith('column')
    ? style.justifyContent
    : style.alignItems;
  if (alignment === 'center') return 'middle';
  if (alignment === 'flex-end' || alignment === 'end') return 'bottom';
  return 'top';
};

const readLayer = (node: RenderedNode): number => {
  if (node.legacyLayer !== undefined) return node.legacyLayer;
  const value = Number(node.style.zIndex);
  return Number.isFinite(value) ? value : 0;
};

const hasVisibleBorder = (style: ComputedNodeStyle): boolean =>
  [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ].some((value) => Number.parseFloat(value) > 0);

const simpleShapeGeometry = (
  node: RenderedNode,
  transform: ReachDeckTransformV2,
): ReachDeckShapeElementV2['geometry'] | undefined => {
  const { style } = node;
  const requested = node.legacyShape;
  if (requested && requested !== 'rect' && requested !== 'roundRect' && requested !== 'ellipse') {
    return undefined;
  }
  const radii = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ];
  if (new Set(radii).size !== 1 || (radii[0]?.includes('%') && radii[0] !== '50%'))
    return undefined;
  const radius = Number.parseFloat(radii[0] ?? '0');
  const shortSide = Math.min(transform.width, transform.height);
  const aspectRatio = shortSide <= 0 ? 1 : Math.max(transform.width, transform.height) / shortSide;
  const preset =
    requested ??
    (radii[0] === '50%' ||
    (aspectRatio <= 1.2 && Number.isFinite(radius) && radius >= shortSide / 2 - 1)
      ? 'ellipse'
      : radius > 0
        ? 'roundRect'
        : 'rect');
  if (preset === 'ellipse') return { kind: 'preset', preset: 'ellipse' };
  if (preset === 'rect') return { kind: 'preset', preset: 'rect' };
  if (!Number.isFinite(radius)) return { kind: 'preset', preset: 'roundRect' };
  const adjustment =
    shortSide <= 0 ? 0 : Math.min(50_000, Math.max(0, (radius / shortSide) * 100_000));
  return { kind: 'preset', preset: 'roundRect', adjustments: { adj: adjustment } };
};

const compileSimpleShape = (
  node: RenderedNode,
  id: string,
  transform: ReachDeckTransformV2,
): ReachDeckShapeElementV2 | undefined => {
  const { style } = node;
  if (style.transform && style.transform !== 'none') return undefined;
  if (
    (style.filter && style.filter !== 'none') ||
    (style.clipPath && style.clipPath !== 'none') ||
    (style.maskImage && style.maskImage !== 'none')
  ) {
    return undefined;
  }
  const fill = solidFillFromStyle(style);
  if (!fill) return undefined;
  const stroke = borderStrokeFromStyle(style);
  if (hasVisibleBorder(style) && !stroke) return undefined;
  const effects = shadowFromStyle(style);
  if (style.boxShadow && style.boxShadow !== 'none' && !effects) return undefined;
  const geometry = simpleShapeGeometry(node, transform);
  if (!geometry) return undefined;
  const opacity = Number.parseFloat(style.opacity);
  return {
    id,
    type: 'shape',
    transform,
    zIndex: 0,
    ...(Number.isFinite(opacity) && opacity >= 0 && opacity < 1 ? { opacity } : {}),
    geometry,
    style: {
      fill,
      ...(stroke ? { stroke } : {}),
      ...(effects ? { effects } : {}),
    },
  };
};

const nativeMetadata = (
  node: RenderedNode,
): Pick<ReachDeckNativeElementV2, 'name' | 'ariaLabel'> => ({
  ...(node.revealGroupId ? { name: `reveal-group:${node.revealGroupId}` } : {}),
  ...(node.decorative ? { ariaLabel: 'decorative' } : {}),
});

const compileSimpleLine = (
  node: RenderedNode,
  id: string,
  transform: ReachDeckTransformV2,
): ReachDeckNativeElementV2 | undefined => {
  const { style } = node;
  if (
    (style.transform && style.transform !== 'none') ||
    (style.backgroundImage && style.backgroundImage !== 'none') ||
    (style.boxShadow && style.boxShadow !== 'none')
  ) {
    return undefined;
  }
  const color = cssColor(style.backgroundColor);
  if (!color || colorIsTransparent(color)) return undefined;
  const horizontal = transform.width >= transform.height;
  const thickness = Math.max(1, Math.min(transform.width, transform.height));
  const opacity = Number.parseFloat(style.opacity);
  return {
    id,
    type: 'line',
    ...nativeMetadata(node),
    transform,
    zIndex: 0,
    ...(Number.isFinite(opacity) && opacity >= 0 && opacity < 1 ? { opacity } : {}),
    start: horizontal ? { x: 0, y: transform.height / 2 } : { x: transform.width / 2, y: 0 },
    end: horizontal
      ? {
          x: transform.width,
          y: transform.height / 2,
          ...(node.legacyArrowEnd ? { marker: 'arrow' as const } : {}),
        }
      : {
          x: transform.width / 2,
          y: transform.height,
          ...(node.legacyArrowEnd ? { marker: 'arrow' as const } : {}),
        },
    routing: 'straight',
    connector: false,
    stroke: { width: thickness, fill: color, dash: 'solid' },
  };
};

const rasterizeVisualElement: RasterizeElement = (element, mode = 'element') => {
  const bounds = element.getBoundingClientRect();
  const width = Math.max(1, Math.ceil((element as HTMLElement).offsetWidth || bounds.width));
  const height = Math.max(1, Math.ceil((element as HTMLElement).offsetHeight || bounds.height));
  return toPng(element as unknown as HTMLElement, {
    width,
    height,
    canvasWidth: width,
    canvasHeight: height,
    pixelRatio: 1,
    skipAutoScale: true,
    style: {
      position: 'relative',
      left: '0px',
      top: '0px',
      right: 'auto',
      bottom: 'auto',
      margin: '0px',
    },
    filter: (node) => {
      if (node.nodeType !== 1) return true;
      if (mode === 'background') return false;
      return true;
    },
  });
};

const themeResourceFromResolvedTheme = (
  themeName: string,
  theme: ReturnType<typeof resolveDeckTheme>,
): ReachDeckThemeResourceV2 => ({
  id: `html-theme-${themeName}`,
  name: theme.name,
  colors: {
    background: theme.background,
    surface: theme.surface,
    ink: theme.ink,
    muted: theme.muted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
  },
  fonts: { display: theme.fontDisplay, body: theme.fontBody },
});

const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'DIV']);

const hasVisibleBoxStyle = (style: ComputedNodeStyle): boolean => {
  const background = cssColor(style.backgroundColor);
  return (
    Boolean(background && !colorIsTransparent(background)) ||
    Boolean(style.backgroundImage && style.backgroundImage !== 'none') ||
    hasVisibleBorder(style) ||
    Boolean(style.boxShadow && style.boxShadow !== 'none')
  );
};

const hasComplexVisualStyle = (style: ComputedNodeStyle): boolean =>
  Boolean(
    (style.backgroundImage && style.backgroundImage !== 'none') ||
    (style.filter && style.filter !== 'none') ||
    (style.clipPath && style.clipPath !== 'none') ||
    (style.maskImage && style.maskImage !== 'none') ||
    (style.transform && style.transform !== 'none'),
  );

const isThinLine = (transform: ReachDeckTransformV2): boolean => {
  const shortSide = Math.min(transform.width, transform.height);
  const longSide = Math.max(transform.width, transform.height);
  return shortSide <= 4 && longSide >= shortSide * 3;
};

const compileTextNode = (
  node: RenderedNode,
  id: string,
  transform: ReachDeckTransformV2,
): ReachDeckTextFrameElementV2 => {
  const opacity = Number.parseFloat(node.style.opacity);
  return {
    id,
    type: 'textFrame',
    transform,
    zIndex: 0,
    ...(Number.isFinite(opacity) && opacity >= 0 && opacity < 1 ? { opacity } : {}),
    ariaLabel: node.text,
    text: {
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
      verticalAlignment: verticalAlignmentFromStyle(node.style),
      wrap: node.style.whiteSpace !== 'nowrap' && node.style.whiteSpace !== 'pre',
      autofit: { mode: 'none' },
      doc: richTextFromRenderedNode(node),
      fontSubstitutions: [],
    },
  };
};

const dataImageContentType = (source: string): string | undefined =>
  source.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp|svg\+xml));/i)?.[1]?.toLowerCase();

export async function compileRenderedHtml(
  document: Document,
  sourceHtml: string,
  measure: MeasureElement = (element) => element.getBoundingClientRect(),
  rasterize: RasterizeElement = rasterizeVisualElement,
): Promise<HtmlDeckCompileResult> {
  const scene = extractRenderedScene(document, measure);
  const { root, rootRect } = scene;
  if (rootRect.width <= 0 || rootRect.height <= 0) {
    throw new Error('HTML 画布没有可测量的尺寸。');
  }
  if (scene.nodes.length === 0) {
    throw new Error('HTML 中没有可转换的文字、图形、视觉组或 SVG。');
  }
  if (scene.nodes.length > MAX_ELEMENTS) {
    throw new Error(`HTML 元素超过 ${MAX_ELEMENTS} 个的限制。`);
  }

  const diagnostics: string[] = [];
  const warnings: HtmlDeckWarning[] = [];
  const warningKeys = new Set<string>();
  const pushWarning = (item: HtmlDeckWarning) => {
    const key = `${item.code}:${item.selector}`;
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(item);
    diagnostics.push(`[${item.code}] ${item.message}`);
  };
  validateRenderedScene(scene).forEach(pushWarning);

  const ids = new Set<string>();
  const entries: Array<{
    sourceIndex: number;
    layer: number;
    element: ReachDeckNativeElementV2;
  }> = [];
  const metadataById = new Map<string, Pick<ReachDeckNativeElementV2, 'name' | 'ariaLabel'>>();
  const rasterCandidates: Array<{
    id: string;
    element: HTMLElement | SVGSVGElement;
    transform: ReachDeckTransformV2;
    sourceIndex: number;
    layer: number;
    mode: 'element' | 'background';
    alt: string;
  }> = [];
  const dataImageCandidates: Array<{
    id: string;
    source: string;
    contentType: string;
    transform: ReachDeckTransformV2;
    sourceIndex: number;
    layer: number;
    alt: string;
  }> = [];
  let fallbackCount = 0;
  let inferredElementCount = 0;
  let legacyElementCount = 0;

  const queueRaster = (
    node: RenderedNode,
    id: string,
    transform: ReachDeckTransformV2,
    layer: number,
    isFallback: boolean,
  ) => {
    if (isFallback) fallbackCount += 1;
    rasterCandidates.push({
      id,
      element: node.sourceElement,
      transform,
      sourceIndex: node.domOrder,
      layer,
      mode: 'element',
      alt: node.alt || id,
    });
  };

  for (const node of scene.nodes) {
    const isLegacy = node.sourceElement.hasAttribute('data-deck-element');
    if (isLegacy) legacyElementCount += 1;
    else inferredElementCount += 1;
    if (!isRenderedNodeVisible(node)) {
      diagnostics.push(`已跳过 ${node.id ?? node.tag.toLowerCase()}：不可见或尺寸为 0。`);
      continue;
    }

    const id = uniqueId(node.id ?? '', node.domOrder, ids);
    metadataById.set(id, {
      ...(node.revealGroupId ? { name: `reveal-group:${node.revealGroupId}` } : {}),
      ...(node.decorative ? { ariaLabel: 'decorative' } : {}),
    });
    if (id !== node.id) {
      diagnostics.push(`元素 ${node.id || node.domOrder + 1} 的 id 已规范化为 ${id}。`);
    }
    const transform = toTransform(node.rect, rootRect);
    const layer = readLayer(node);
    const declaredKind = node.sourceElement.dataset.kind;

    if (node.legacyKind === 'visual' || node.tag === 'FIGURE') {
      // Layout-drawn figures are decoration only; text inside one signals a self-drawn
      // teaching diagram. Report it for evidence, without rewriting the page.
      const figureText = node.sourceElement.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      if (node.tag === 'FIGURE' && figureText)
        pushWarning(
          createNodeWarning(
            'LAYOUT_FIGURE_CONTENT',
            node,
            `自绘 figure ${id} 含文字"${figureText.slice(0, 40)}"，版式图应只承担装饰；教学内容图应来自素材。`,
          ),
        );
      queueRaster(node, id, transform, layer, false);
      continue;
    }

    if (node.tag === 'IMG') {
      const source = node.sourceElement.getAttribute('src')?.trim() ?? '';
      const contentType = dataImageContentType(source);
      if (contentType) {
        dataImageCandidates.push({
          id,
          source,
          contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType,
          transform,
          sourceIndex: node.domOrder,
          layer,
          alt: node.alt || id,
        });
      } else {
        pushWarning(
          createNodeWarning(
            'INVALID_IMAGE_SOURCE',
            node,
            `图片 ${id} 没有可用的 data:image 源，已按渲染结果保留。`,
          ),
        );
        pushWarning(
          createNodeWarning(
            'AUTO_FLATTENED_COMPLEX_SUBTREE',
            node,
            `图片 ${id} 已自动降级为视觉资源。`,
          ),
        );
        queueRaster(node, id, transform, layer, true);
      }
      continue;
    }

    if (node.tag === 'SVG') {
      queueRaster(node, id, transform, layer, false);
      continue;
    }

    if (node.legacyKind === 'text') {
      if (!node.text) {
        diagnostics.push(`已跳过文本元素 ${id}：内容为空。`);
        continue;
      }
      entries.push({
        sourceIndex: node.domOrder,
        layer,
        element: compileTextNode(node, id, transform),
      });
      continue;
    }

    if (node.legacyKind === 'shape' || node.legacyKind === 'line') {
      const nativeElement =
        node.legacyKind === 'shape'
          ? compileSimpleShape(node, id, transform)
          : compileSimpleLine(node, id, transform);
      if (nativeElement) {
        entries.push({ sourceIndex: node.domOrder, layer, element: nativeElement });
      } else {
        pushWarning(
          createNodeWarning(
            'AUTO_FLATTENED_COMPLEX_SUBTREE',
            node,
            `旧标记元素 ${id} 包含复杂样式，已作为独立视觉资源保留。`,
          ),
        );
        queueRaster(node, id, transform, layer, true);
      }
      continue;
    }

    if (declaredKind) {
      pushWarning(
        createNodeWarning(
          'UNKNOWN_VISIBLE_NODE',
          node,
          `元素 ${id} 使用未知 data-kind「${declaredKind}」，将按最终渲染结果处理。`,
        ),
      );
    }

    if (node.text && TEXT_TAGS.has(node.tag)) {
      if (!hasOnlyInlineTextChildren(node)) {
        pushWarning(
          createNodeWarning(
            'TEXT_WITH_COMPLEX_CHILDREN',
            node,
            `文本元素 ${id} 含有复杂子节点，无法安全拆成独立文本。`,
          ),
        );
        pushWarning(
          createNodeWarning(
            'AUTO_FLATTENED_COMPLEX_SUBTREE',
            node,
            `复杂文本子树 ${id} 已自动降级为视觉资源。`,
          ),
        );
        queueRaster(node, id, transform, layer, true);
        continue;
      }
      if (hasComplexVisualStyle(node.style)) {
        const code =
          node.style.backgroundImage && node.style.backgroundImage !== 'none'
            ? 'UNSUPPORTED_BACKGROUND'
            : 'AUTO_FLATTENED_COMPLEX_SUBTREE';
        pushWarning(
          createNodeWarning(code, node, `文本元素 ${id} 使用复杂视觉样式，已按整体视觉保留。`),
        );
        pushWarning(
          createNodeWarning(
            'AUTO_FLATTENED_COMPLEX_SUBTREE',
            node,
            `复杂文本元素 ${id} 已自动降级为视觉资源。`,
          ),
        );
        queueRaster(node, id, transform, layer, true);
        continue;
      }
      if (hasVisibleBoxStyle(node.style)) {
        const backgroundId = uniqueId(`${id}-background`, node.domOrder, ids);
        const shape = compileSimpleShape(node, backgroundId, transform);
        if (!shape) {
          pushWarning(
            createNodeWarning(
              'AUTO_FLATTENED_COMPLEX_SUBTREE',
              node,
              `带背景文本 ${id} 无法安全拆解，已自动降级为视觉资源。`,
            ),
          );
          queueRaster(node, id, transform, layer, true);
          continue;
        }
        entries.push({ sourceIndex: node.domOrder, layer, element: shape });
      }
      entries.push({
        sourceIndex: node.domOrder,
        layer,
        element: compileTextNode(node, id, transform),
      });
      continue;
    }

    if (!node.text && node.children.length === 0 && isThinLine(transform)) {
      const line = compileSimpleLine(node, id, transform);
      if (line) {
        entries.push({ sourceIndex: node.domOrder, layer, element: line });
        continue;
      }
    }

    if (!node.text && node.children.length === 0 && hasVisibleBoxStyle(node.style)) {
      const shape = compileSimpleShape(node, id, transform);
      if (shape) {
        entries.push({ sourceIndex: node.domOrder, layer, element: shape });
        continue;
      }
      if (node.style.backgroundImage && node.style.backgroundImage !== 'none') {
        pushWarning(
          createNodeWarning(
            'UNSUPPORTED_BACKGROUND',
            node,
            `元素 ${id} 使用复杂背景，已按视觉资源保留。`,
          ),
        );
      }
    }

    pushWarning(
      createNodeWarning(
        'UNKNOWN_VISIBLE_NODE',
        node,
        `可见元素 ${id} 无法可靠映射为基础 primitive。`,
      ),
    );
    pushWarning(
      createNodeWarning(
        'AUTO_FLATTENED_COMPLEX_SUBTREE',
        node,
        `元素 ${id} 已自动降级为视觉资源，未静默丢弃。`,
      ),
    );
    queueRaster(node, id, transform, layer, true);
  }

  const requestedTheme = root.dataset.theme ?? 'reach-classic';
  const themeName = THEME_NAMES.has(requestedTheme) ? requestedTheme : 'reach-classic';
  if (themeName !== requestedTheme)
    diagnostics.push(`未知主题 ${requestedTheme}，已回退到 reach-classic。`);
  const theme = resolveDeckTheme(themeName);
  const themeResource = themeResourceFromResolvedTheme(themeName, theme);
  const title = root.dataset.title?.trim() || document.title.trim() || 'HTML Generated Slide';
  const sourceDigest = hash(sourceHtml);
  const rootColor = cssColor(scene.rootStyle.backgroundColor);
  const slideBackground: ReachDeckFillV2 =
    rootColor && !colorIsTransparent(rootColor)
      ? { kind: 'solid', color: rootColor }
      : { kind: 'solid', color: { kind: 'srgb', value: theme.background } };
  if (scene.rootStyle.backgroundImage && scene.rootStyle.backgroundImage !== 'none') {
    rasterCandidates.push({
      id: uniqueId('html-background', -1, ids),
      element: root,
      transform: { x: 0, y: 0, width: STAGE.width, height: STAGE.height },
      sourceIndex: -1,
      layer: -1_000_000,
      mode: 'background',
      alt: `${title} background`,
    });
  }

  const media: ReachDeckMediaResourceV2[] = [];
  const resourceUrlsById: Record<string, string> = {};
  for (const candidate of dataImageCandidates) {
    const resourceId = `html-media-${hash(`${sourceDigest}:${candidate.id}:${candidate.source}`)}`;
    const extension =
      candidate.contentType === 'image/svg+xml'
        ? 'svg'
        : candidate.contentType.split('/')[1] || 'img';
    media.push({
      id: resourceId,
      objectKey: `inline/${candidate.id}-${sourceDigest}.${extension}`,
      contentType: candidate.contentType,
      digest: `html:${sourceDigest}:${candidate.id}`,
    });
    resourceUrlsById[resourceId] = candidate.source;
    entries.push({
      sourceIndex: candidate.sourceIndex,
      layer: candidate.layer,
      element: {
        id: candidate.id,
        type: 'image',
        transform: candidate.transform,
        zIndex: 0,
        resourceId,
        fit: 'stretch',
        alt: candidate.alt,
      },
    });
  }
  for (const candidate of rasterCandidates) {
    const resourceId = `html-media-${hash(`${sourceDigest}:${candidate.id}`)}`;
    const raster = await rasterize(candidate.element, candidate.mode);
    const rasterUrl = typeof raster === 'string' ? raster : raster.dataUrl;
    media.push({
      id: resourceId,
      objectKey: `inline/${candidate.id}-${sourceDigest}.png`,
      contentType: 'image/png',
      digest: `html:${sourceDigest}:${candidate.id}`,
    });
    resourceUrlsById[resourceId] = rasterUrl;
    entries.push({
      sourceIndex: candidate.sourceIndex,
      layer: candidate.layer,
      element: {
        id: candidate.id,
        type: 'image',
        transform:
          typeof raster === 'string' ? candidate.transform : toTransform(raster.bounds, rootRect),
        zIndex: 0,
        resourceId,
        fit: 'stretch',
        alt: candidate.alt,
      },
    });
  }

  const elements = [...entries]
    .sort((left, right) => left.layer - right.layer || left.sourceIndex - right.sourceIndex)
    .map((entry, zIndex) => ({
      ...entry.element,
      ...metadataById.get(entry.element.id),
      zIndex,
    }));

  const generatedAt = new Date().toISOString();
  const nativeDocument = parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: 'html-deck-v2-demo',
    title,
    stage: { ...STAGE, aspectRatio: '16:9' },
    theme,
    defaultThemeId: themeResource.id,
    resources: {
      themes: [themeResource],
      masters: [],
      layouts: [],
      media,
    },
    metadata: {
      source: 'api',
      language: 'zh-CN',
      generatedAt,
      contentDigest: `html:${sourceDigest}`,
    },
    revisions: [],
    pages: [
      {
        pageId: 'html-page-1',
        order: 1,
        revision: 1,
        sceneType: 'slide',
        title,
      },
    ],
    nativeSlides: [
      {
        pageId: 'html-page-1',
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          textCompatibility: 'native',
          id: 'html-slide-1',
          title,
          background: slideBackground,
          elements,
          animations: [],
        },
      },
    ],
  });

  return {
    document: nativeDocument,
    diagnostics,
    elementCount: elements.length,
    themeName,
    resourceUrlsById,
    warnings,
    telemetry: {
      fallbackCount,
      inferredElementCount,
      legacyElementCount,
      warningCounts: warnings.reduce<Partial<Record<HtmlDeckWarningCode, number>>>(
        (counts, item) => {
          counts[item.code] = (counts[item.code] ?? 0) + 1;
          return counts;
        },
        {},
      ),
    },
  };
}

export const compileIframe = async (
  iframe: HTMLIFrameElement,
  sourceHtml: string,
): Promise<HtmlDeckCompileResult> => {
  if (!iframe.contentDocument) throw new Error('无法访问 HTML 预览文档。');
  return compileRenderedHtml(iframe.contentDocument, sourceHtml);
};
