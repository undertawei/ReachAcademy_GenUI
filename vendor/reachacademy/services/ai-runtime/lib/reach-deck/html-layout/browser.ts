import {
  compileRenderedHtml,
  sanitizeGeneratedHtml,
} from '../../../scripts/reach-deck/html-layout/htmlPipeline';
import { resolvePptSafeTailwind } from '../../../scripts/reach-deck/html-layout/tailwindResolver';
import {
  HTML_MATH_CSS,
  HTML_MATH_SELECTOR,
  prepareHtmlMath,
} from '../../../scripts/reach-deck/html-layout/math';
import {
  resolveDeckTheme,
  resolveDeckDesignTheme,
  assertCurrentReferenceLibrary,
  createThemeResource,
} from '@reachany/reach-deck-dsl';
import { getReferenceEntry } from '@reachany/reach-deck-dsl/reference-library';
import { extractReferenceTables, installTablePlaceholders } from './reference-tables';
import { checkReferenceContrast } from './reference-contrast';
import { autofitSlideText } from './text-autofit';
import { shadowRasterBounds } from './raster-bounds';
import { checkSlideSpacing } from './layout-spacing';
import {
  HTML_LAYOUT_LIMITS,
  HtmlLayoutValidationError,
  createLayoutDiagnostics,
  type ReportLayoutDiagnostic,
  type CompileHtmlLayoutInput,
  type HtmlLayoutFontRun,
  type HtmlLayoutResult,
} from './types';

const REFERENCE_ASSET_REPAIR =
  'Use one empty DIV directly under section#slide with the same data-reach-asset ID and absolute left/top/width/height. Set border:0; border-radius:0; transform:none; filter:none; box-shadow:none; mask-image:none; clip-path:none; object-fit:fill, contain or cover. Use only a registered data-reach-asset-mask if masking is needed. Put frames, shadows, backgrounds, overlays and captions in separate slide-level siblings, not on/inside the trusted slot. Do not redraw, rasterize or generate another asset.';

declare global {
  interface Window {
    compileProductionHtml: typeof compileProductionHtml;
    capturePreparedHtml?: (html: string) => Promise<void>;
    resolveLayoutFonts: (runs: HtmlLayoutFontRun[]) => Promise<string[]>;
    captureLayoutRaster: (rect: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<string>;
  }
}

const EMPTY_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

function checkDom(document: Document): void {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
  let count = 0;
  while (walker.nextNode())
    if (++count > HTML_LAYOUT_LIMITS.domNodes)
      throw new HtmlLayoutValidationError('HTML layout DOM node budget exceeded.');
}

function normalizeIds(root: HTMLElement): Record<string, string> {
  const seen = new Set<string>();
  const mapping: Record<string, string> = Object.create(null);
  Array.from(root.querySelectorAll<HTMLElement>('*')).forEach((element, index) => {
    if (!element.id && element.parentElement !== root) return;
    const original = element.id;
    if (original && Object.hasOwn(mapping, original))
      throw new HtmlLayoutValidationError('Duplicate HTML element ID.');
    const base =
      original
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `element-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (seen.has(id)) id = `${base}-${suffix++}`;
    seen.add(id);
    element.id = id;
    if (original) mapping[original] = id;
  });
  return mapping;
}

type InkRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
const outside = (ink: InkRect, box: InkRect) =>
  ink.left < box.left - 1 ||
  ink.right > box.right + 1 ||
  ink.top < box.top - 1 ||
  ink.bottom > box.bottom + 1;

function textInkRects(document: Document, element: Element): InkRect[] {
  const canvas = document.createElement('canvas').getContext('2d')!;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const result: InkRect[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('.katex-mathml')) continue;
    const style = document.defaultView!.getComputedStyle(node.parentElement!);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      continue;
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    for (const part of segmenter.segment(node.data)) {
      if (!part.segment.trim()) continue;
      const text =
        style.textTransform === 'uppercase'
          ? part.segment.toUpperCase()
          : style.textTransform === 'lowercase'
            ? part.segment.toLowerCase()
            : part.segment;
      const metrics = canvas.measureText(text);
      const range = document.createRange();
      range.setStart(node, part.index);
      range.setEnd(node, part.index + part.segment.length);
      for (const rect of range.getClientRects()) {
        // Range includes the font's ascent/descent, not painted glyph bounds. The
        // shared bundled face supplies the baseline; actual metrics supply ink.
        const baseline = rect.top + metrics.fontBoundingBoxAscent;
        result.push({
          left: rect.left - metrics.actualBoundingBoxLeft,
          right: rect.left + metrics.actualBoundingBoxRight,
          top: baseline - metrics.actualBoundingBoxAscent,
          bottom: baseline + metrics.actualBoundingBoxDescent,
        });
      }
    }
  }
  return result;
}

function isInlineVisualBaselineOverflow(document: Document, figure: Element): boolean {
  if (figure.tagName !== 'FIGURE' || figure.children.length === 0) return false;
  if (
    Array.from(figure.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    )
  )
    return false;
  if (
    Array.from(figure.children).some((node) => !['svg', 'img'].includes(node.tagName.toLowerCase()))
  )
    return false;
  const view = document.defaultView!;
  const bounds = figure.getBoundingClientRect();
  const style = view.getComputedStyle(figure);
  const clip = {
    left: bounds.left + parseFloat(style.borderLeftWidth),
    right: bounds.right - parseFloat(style.borderRightWidth),
    top: bounds.top + parseFloat(style.borderTopWidth),
    bottom: bounds.bottom - parseFloat(style.borderBottomWidth),
  };
  for (const node of [figure, ...Array.from(figure.querySelectorAll('*'))]) {
    const computed = view.getComputedStyle(node);
    if (
      computed.display === 'none' ||
      computed.visibility === 'hidden' ||
      Number(computed.opacity) === 0
    )
      continue;
    if (
      node.tagName.toLowerCase() === 'foreignobject' ||
      computed.transform !== 'none' ||
      computed.filter !== 'none' ||
      computed.boxShadow !== 'none'
    )
      return false;
    for (const pseudo of ['::before', '::after']) {
      const content = view.getComputedStyle(node, pseudo).content;
      if (content !== 'none' && content !== 'normal' && content !== '""') return false;
    }
    if (node === figure) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    // SVG geometric bounds omit stroke paint, including miter joins.
    const stroke =
      computed.stroke !== 'none'
        ? (parseFloat(computed.strokeWidth) *
            Math.max(1, parseFloat(computed.strokeMiterlimit) || 1)) /
          2
        : 0;
    if (
      outside(
        {
          left: rect.left - stroke,
          right: rect.right + stroke,
          top: rect.top - stroke,
          bottom: rect.bottom + stroke,
        },
        clip,
      )
    )
      return false;
  }
  return true;
}

function checkText(document: Document, root: HTMLElement, report: ReportLayoutDiagnostic): void {
  const rootBounds = root.getBoundingClientRect();
  const independentText: { element: Element; ink: InkRect[]; paint: InkRect[] }[] = [];
  const intersects = (a: InkRect, b: InkRect) =>
    Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
    Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1;
  const visibleColor = (color: string) =>
    color !== 'transparent' &&
    !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color) &&
    !/\/\s*0(?:\.0+)?\s*\)$/.test(color);
  for (const element of Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div'))) {
    if (
      !/^(H[1-6]|P|DIV)$/.test(element.tagName) ||
      !element.textContent?.trim() ||
      element.hasAttribute('data-reach-asset')
    )
      continue;
    if (element.closest('figure,svg,[data-reach-asset]')) continue;
    if (element.querySelector('figure,svg,img,div,p,h1,h2,h3,h4,h5,h6')) continue;
    const style = document.defaultView!.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      continue;
    if (style.writingMode !== 'horizontal-tb')
      report(
        element.id,
        `UNSUPPORTED_WRITING_MODE: ${element.id} uses ${style.writingMode}; use horizontal labels for native text.`,
      );
    const bounds = element.getBoundingClientRect();
    const left = bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right =
      bounds.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const top = bounds.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const bottom =
      bounds.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    const ink = textInkRects(document, element);
    const paint: InkRect[] = [];
    if (visibleColor(style.backgroundColor) || style.backgroundImage !== 'none') paint.push(bounds);
    for (const side of ['Left', 'Right', 'Top', 'Bottom'] as const) {
      const width = parseFloat(style[`border${side}Width`]);
      if (!width || !visibleColor(style[`border${side}Color`])) continue;
      paint.push({
        left: side === 'Right' ? bounds.right - width : bounds.left,
        right: side === 'Left' ? bounds.left + width : bounds.right,
        top: side === 'Bottom' ? bounds.bottom - width : bounds.top,
        bottom: side === 'Top' ? bounds.top + width : bounds.bottom,
      });
    }
    independentText.push({ element, ink, paint });
    const reportOverflow = (reason: string, collision?: { glyph: InkRect; sibling: InkRect }) => {
      report(
        element.id,
        `TEXT_OVERFLOW: ${element.id} ${reason} ${JSON.stringify({ box: { left, right, top, bottom }, ...(collision ? { collision } : { ink: ink.slice(0, 8) }) })}`.slice(
          0,
          1400,
        ),
      );
    };
    if (ink.some((rect) => outside(rect, rootBounds)))
      reportOverflow('painted text exceeds slide canvas');
    for (
      let ancestor: Element | null = element;
      ancestor && ancestor !== root.parentElement;
      ancestor = ancestor.parentElement
    ) {
      const ancestorStyle = document.defaultView!.getComputedStyle(ancestor);
      const clipX = ancestorStyle.overflowX !== 'visible';
      const clipY = ancestorStyle.overflowY !== 'visible';
      if (!clipX && !clipY) continue;
      const clip = ancestor.getBoundingClientRect();
      const clipBox = {
        left: clip.left + parseFloat(ancestorStyle.borderLeftWidth),
        right: clip.right - parseFloat(ancestorStyle.borderRightWidth),
        top: clip.top + parseFloat(ancestorStyle.borderTopWidth),
        bottom: clip.bottom - parseFloat(ancestorStyle.borderBottomWidth),
      };
      if (
        ink.some(
          (rect) =>
            (clipX && (rect.left < clipBox.left - 1 || rect.right > clipBox.right + 1)) ||
            (clipY && (rect.top < clipBox.top - 1 || rect.bottom > clipBox.bottom + 1)),
        )
      )
        reportOverflow('painted text is clipped');
    }
    const overflow = ink.filter((rect) => outside(rect, { left, right, top, bottom }));
    for (const sibling of Array.from(root.children)) {
      if (sibling === element || sibling.contains(element)) continue;
      const siblingStyle = document.defaultView!.getComputedStyle(sibling);
      if (
        siblingStyle.display === 'none' ||
        siblingStyle.visibility === 'hidden' ||
        Number(siblingStyle.opacity) === 0
      )
        continue;
      const other = sibling.getBoundingClientRect();
      // Enclosing background shapes are intentional; only escaped ink that
      // enters another independent element is a layout collision.
      if (!outside(bounds, other)) continue;
      const conflictingGlyph = overflow.find((rect) => {
        const overlap = {
          left: Math.max(rect.left, other.left),
          right: Math.min(rect.right, other.right),
          top: Math.max(rect.top, other.top),
          bottom: Math.min(rect.bottom, other.bottom),
        };
        return (
          overlap.right > overlap.left + 1 &&
          overlap.bottom > overlap.top + 1 &&
          outside(overlap, { left, right, top, bottom })
        );
      });
      if (conflictingGlyph)
        reportOverflow(
          `painted overflow intersects ${sibling.id || sibling.tagName.toLowerCase()}`,
          {
            glyph: conflictingGlyph,
            sibling: { left: other.left, right: other.right, top: other.top, bottom: other.bottom },
          },
        );
    }
    if (overflow.length)
      report(
        element.id,
        `[TEXT_INK_OVERFLOW_VISIBLE] ${element.id}: text ink extends outside its frame.`,
      );
  }
  // Only independent text blocks participate. Empty backgrounds and figure labels
  // intentionally overlap text and must not be treated as competing paragraphs.
  for (let index = 0; index < independentText.length; index++) {
    const first = independentText[index]!;
    for (const second of independentText.slice(index + 1)) {
      if (first.ink.some((a) => second.ink.some((b) => intersects(a, b))))
        report(
          first.element.id,
          `TEXT_COLLISION: ${first.element.id} painted text intersects ${second.element.id}`,
        );
      for (const [foreground, background] of [
        [first, second],
        [second, first],
      ] as const) {
        for (const paint of foreground.paint) {
          for (const ink of background.ink) {
            if (!intersects(paint, ink)) continue;
            const x = (Math.max(paint.left, ink.left) + Math.min(paint.right, ink.right)) / 2;
            const y = (Math.max(paint.top, ink.top) + Math.min(paint.bottom, ink.bottom)) / 2;
            const top = document
              .elementsFromPoint(x, y)
              .find((candidate) =>
                [foreground.element, background.element].some((text) => text.contains(candidate)),
              );
            if (top && foreground.element.contains(top))
              report(
                foreground.element.id,
                `TEXT_COLLISION: ${foreground.element.id} background or border obscures ${background.element.id} painted text`,
              );
          }
        }
      }
    }
  }
}

async function compileProductionHtml(
  input: Omit<CompileHtmlLayoutInput, 'signal' | 'onPreparedHtml'> & {
    fontCss: string;
    capturePreparedHtml?: boolean;
  },
): Promise<HtmlLayoutResult> {
  if (input.designContext) {
    try {
      assertCurrentReferenceLibrary(input.designContext);
    } catch {
      throw new HtmlLayoutValidationError(
        'HTML layout requires a valid current reference library design context.',
      );
    }
  }
  const initial = new DOMParser().parseFromString(input.html, 'text/html');
  checkDom(initial);
  if (
    initial.querySelectorAll('section#slide').length !== 1 ||
    initial.querySelectorAll('#slide,[data-deck-slide]').length !== 1
  )
    throw new HtmlLayoutValidationError('HTML layout requires exactly one section#slide.');
  const sanitized = sanitizeGeneratedHtml(input.html);
  const document = new DOMParser().parseFromString(
    sanitizeGeneratedHtml(await resolvePptSafeTailwind(sanitized)),
    'text/html',
  );
  const root = document.querySelector<HTMLElement>('#slide,[data-deck-slide]');
  if (!root) throw new HtmlLayoutValidationError('Missing HTML slide root.');
  root.dataset.theme = input.themeName;
  const theme = input.designContext
    ? resolveDeckDesignTheme(input.themeName, input.designContext)
    : resolveDeckTheme(input.themeName);
  root.style.fontFamily ||= theme.fontBody;
  if (input.designContext) {
    const defaults = document.createElement('style');
    defaults.textContent = `:where(#slide){background-color:${theme.background};color:${theme.ink}}`;
    document.head.prepend(defaults);
  }
  const assets = new Map(input.assets.map((asset) => [asset.assetId, asset]));
  if (assets.size !== input.assets.length) throw new Error('Duplicate input asset ID.');
  const referenced = new Set<string>();
  for (const slot of Array.from(
    document.querySelectorAll<HTMLElement>('[data-reach-asset],[data-reach-scientific-asset]'),
  )) {
    const id = slot.dataset.reachAsset ?? slot.dataset.reachScientificAsset!;
    const asset = assets.get(id);
    if (!asset || referenced.has(id))
      throw new HtmlLayoutValidationError('Unknown or duplicate HTML asset reference.');
    if (slot.parentElement !== root || slot.children.length > 0 || slot.textContent?.trim())
      throw new HtmlLayoutValidationError(
        input.designContext
          ? `ASSET_SLOT: ${(slot.id || id).slice(0, 80)} (${slot.tagName}) must be an empty direct section#slide child. ${REFERENCE_ASSET_REPAIR}`.slice(
              0,
              1400,
            )
          : 'Asset slots must be empty slide-level elements.',
      );
    referenced.add(id);
    const image = document.createElement('img');
    for (const attr of Array.from(slot.attributes)) image.setAttribute(attr.name, attr.value);
    if (asset.kind === 'image' && asset.isPlaceholder)
      image.removeAttribute('data-reach-asset-mask');
    image.dataset.reachAsset = id;
    image.id ||= asset.kind === 'scientificVisual' ? asset.element.id : `asset-${id}`;
    image.src = asset.kind === 'image' ? asset.dataUrl : EMPTY_IMAGE;
    slot.replaceWith(image);
  }
  if (referenced.size !== assets.size)
    throw new HtmlLayoutValidationError('HTML layout omitted a required asset.');
  const elementIdMap = normalizeIds(root);
  const visualDiagnostics = createLayoutDiagnostics();
  for (const element of root.querySelectorAll<HTMLElement>('[style]')) {
    const rawStyle = element.getAttribute('style') ?? '';
    for (const match of rawStyle.matchAll(/(?:^|;)\s*(line-height|font-size)\s*:\s*([^;]+)/gi)) {
      const property = match[1]!.toLowerCase();
      const value = match[2]!.trim().replace(/\s*!important\s*$/i, '');
      if (!CSS.supports(property, value)) {
        visualDiagnostics.report(
          element.id,
          `INVALID_TEXT_STYLE: ${element.id} has unsupported ${property}: ${value}`,
        );
      }
    }
  }
  for (const diagnostic of prepareHtmlMath(document)) visualDiagnostics.report('math', diagnostic);
  const fonts = document.createElement('style');
  fonts.dataset.layoutFonts = 'true';
  fonts.textContent = `${input.fontCss}\n${HTML_MATH_CSS}`;
  document.head.append(fonts);
  checkDom(document);
  const iframe = window.document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.style.cssText = 'border:0;width:1600px;height:900px;position:absolute;left:0;top:0';
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = '<!doctype html>\n' + document.documentElement.outerHTML;
  window.document.body.append(iframe);
  await loaded;
  const rendered = iframe.contentDocument!;
  const renderedRoot = rendered.querySelector<HTMLElement>('#slide,[data-deck-slide]')!;
  const view = rendered.defaultView!;
  const textNodes: Text[] = [];
  const walker = rendered.createTreeWalker(renderedRoot, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (
      node.textContent?.trim() &&
      !node.parentElement?.closest(`style,script,svg,${HTML_MATH_SELECTOR}`)
    )
      textNodes.push(node);
  }
  const selectedFonts = await window.resolveLayoutFonts(
    textNodes.map((node) => ({
      family: view.getComputedStyle(node.parentElement!).fontFamily,
      text: node.textContent!,
    })),
  );
  textNodes.forEach((node, index) => {
    const span = rendered.createElement('span');
    span.style.fontFamily = `"${selectedFonts[index]}"`;
    node.replaceWith(span);
    span.append(node);
  });
  checkDom(rendered);
  renderedRoot.getBoundingClientRect();
  await rendered.fonts.ready;
  let pixels = 0;
  const consumePixels = (width: number, height: number) => {
    const size = Math.ceil(width) * Math.ceil(height);
    pixels += size;
    if (size > HTML_LAYOUT_LIMITS.imagePixels || pixels > HTML_LAYOUT_LIMITS.totalPixels)
      throw new HtmlLayoutValidationError('HTML layout decoded pixel budget exceeded.');
  };
  await Promise.all(
    Array.from(rendered.images, async (image) => {
      await image.decode();
      consumePixels(image.naturalWidth, image.naturalHeight);
    }),
  );
  await new Promise<void>((resolve) =>
    view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())),
  );
  const rootRect = renderedRoot.getBoundingClientRect();
  if (Math.abs(rootRect.width - 1600) > 1 || Math.abs(rootRect.height - 900) > 1)
    throw new HtmlLayoutValidationError('HTML layout canvas must be 1600x900.');
  const trustedMaskClips = new Map<string, string>();
  for (const image of Array.from(
    renderedRoot.querySelectorAll<HTMLElement>('[data-reach-asset-mask]'),
  )) {
    const maskId = image.dataset.reachAssetMask!;
    if (
      !input.designContext ||
      !image.dataset.reachAsset ||
      assets.get(image.dataset.reachAsset)?.kind !== 'image'
    )
      throw new HtmlLayoutValidationError(
        'Registered image masks require a trusted image asset and reference design protocol.',
      );
    if (
      view.getComputedStyle(image).clipPath !== 'none' ||
      view.getComputedStyle(image).maskImage !== 'none'
    )
      throw new HtmlLayoutValidationError('Arbitrary CSS masks and clip paths are not supported.');
    const mask = (() => {
      try {
        return getReferenceEntry('masks', maskId);
      } catch {
        throw new HtmlLayoutValidationError(
          `Unknown registered asset mask: ${maskId.slice(0, 160)}`,
        );
      }
    })();
    if (mask.geometry.kind !== 'custom-path' || mask.geometry.pathCount !== 1)
      throw new HtmlLayoutValidationError(
        `Unsupported registered asset mask: ${maskId.slice(0, 160)}`,
      );
    const svg = rendered.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const clip = rendered.createElementNS(svg.namespaceURI, 'clipPath');
    clip.id = `host-mask-${trustedMaskClips.size}`;
    clip.setAttribute('clipPathUnits', 'objectBoundingBox');
    const path = rendered.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', mask.geometry.path);
    path.setAttribute(
      'transform',
      `scale(${1 / mask.geometry.viewBox.width},${1 / mask.geometry.viewBox.height})`,
    );
    clip.append(path);
    svg.append(clip);
    rendered.body.append(svg);
    image.style.clipPath = `url("#${clip.id}")`;
    trustedMaskClips.set(image.id, view.getComputedStyle(image).clipPath);
  }
  autofitSlideText(renderedRoot, visualDiagnostics.report);
  if (input.capturePreparedHtml && window.capturePreparedHtml) {
    const snapshot = rendered.documentElement.cloneNode(true) as HTMLElement;
    snapshot.querySelectorAll('style[data-layout-fonts]').forEach((element) => element.remove());
    snapshot
      .querySelectorAll('img[data-reach-asset]')
      .forEach((element) => element.removeAttribute('src'));
    await window.capturePreparedHtml('<!doctype html>\n' + snapshot.outerHTML);
  }
  checkText(rendered, renderedRoot, visualDiagnostics.report);
  checkSlideSpacing(rendered, renderedRoot, visualDiagnostics.report);
  const tables = extractReferenceTables(
    rendered,
    renderedRoot,
    textInkRects,
    visualDiagnostics.report,
  );
  await checkReferenceContrast(rendered, renderedRoot, consumePixels, visualDiagnostics.report);
  installTablePlaceholders(rendered, tables);

  const compiled = await compileRenderedHtml(
    rendered,
    sanitized,
    undefined,
    async (element, mode) => {
      if (element.tagName === 'TABLE' || element.querySelector('table'))
        throw new HtmlLayoutValidationError('Native teaching tables cannot be rasterized.');
      const rect =
        mode === 'background'
          ? element.getBoundingClientRect()
          : shadowRasterBounds(
              element.getBoundingClientRect(),
              view.getComputedStyle(element).boxShadow,
            );
      consumePixels(rect.width, rect.height);
      if (
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.width <= 0 ||
        rect.height <= 0
      )
        throw new HtmlLayoutValidationError('HTML raster requires finite positive geometry.');
      const clipped = {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.max(0, Math.min(1600, rect.right) - Math.max(0, rect.left)),
        height: Math.max(0, Math.min(900, rect.bottom) - Math.max(0, rect.top)),
      };
      const outOfBounds = rect.left < 0 || rect.top < 0 || rect.right > 1600 || rect.bottom > 900;
      if (outOfBounds)
        visualDiagnostics.report(
          element.id,
          `[OUT_OF_CANVAS] ${element.id}: raster extends outside the slide.`,
        );
      if (!clipped.width || !clipped.height) return EMPTY_IMAGE;
      const styles = new Map<Element, string | null>();
      for (const item of [
        rendered.documentElement,
        rendered.body,
        renderedRoot,
        ...Array.from(renderedRoot.querySelectorAll('*')),
      ])
        styles.set(item, item.getAttribute('style'));
      try {
        // Chromium paints only this visual subtree; neighboring content and the slide background are excluded.
        for (const child of Array.from(renderedRoot.querySelectorAll('*')) as HTMLElement[])
          if (child !== element && !element.contains(child))
            child.style.setProperty('visibility', 'hidden', 'important');
        if (mode === 'background') {
          for (const child of Array.from(renderedRoot.querySelectorAll('*')) as HTMLElement[])
            child.style.setProperty('visibility', 'hidden', 'important');
        } else {
          rendered.documentElement.style.setProperty('background', 'transparent', 'important');
          rendered.body.style.setProperty('background', 'transparent', 'important');
          renderedRoot.style.setProperty('background', 'transparent', 'important');
          (element as HTMLElement).style.setProperty('visibility', 'visible', 'important');
        }
        const captured = await window.captureLayoutRaster(clipped);
        const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        if (!outOfBounds) return { dataUrl: captured, bounds };
        // Preserve the original extent; missing off-stage pixels remain transparent.
        const canvas = rendered.createElement('canvas');
        canvas.width = Math.ceil(rect.width);
        canvas.height = Math.ceil(rect.height);
        const image = new Image();
        image.src = captured;
        await image.decode();
        canvas
          .getContext('2d')!
          .drawImage(image, clipped.x - rect.x, clipped.y - rect.y, clipped.width, clipped.height);
        return { dataUrl: canvas.toDataURL('image/png'), bounds };
      } finally {
        for (const [item, style] of styles)
          if (style === null) item.removeAttribute('style');
          else item.setAttribute('style', style);
      }
    },
  );
  const slide = compiled.document.nativeSlides[0]!.slide;
  slide.id = input.pageId;
  for (let index = 0; index < slide.elements.length; index++) {
    const table = tables.get(slide.elements[index]!.id);
    if (table) slide.elements[index] = { ...table, zIndex: slide.elements[index]!.zIndex };
  }
  if (
    Array.from(tables.keys()).some(
      (id) => !slide.elements.some((element) => element.id === id && element.type === 'table'),
    )
  )
    throw new HtmlLayoutValidationError('A required native table was not compiled.');
  const resources: HtmlLayoutResult['resources'] = [];
  const assetBindings: HtmlLayoutResult['assetBindings'] = [];
  const existingIds = new Set<string>();
  const compiledAssetIds = new Set<string>();
  for (let index = 0; index < slide.elements.length; index++) {
    const element = slide.elements[index]!;
    const source = rendered.getElementById(element.id) as HTMLElement | null;
    if (element.type === 'textFrame' && source) {
      const style = view.getComputedStyle(source);
      element.text.margins = {
        left: parseFloat(style.paddingLeft),
        right: parseFloat(style.paddingRight),
        top: parseFloat(style.paddingTop),
        bottom: parseFloat(style.paddingBottom),
      };
    }
    if (element.type !== 'image' || !source) continue;
    const assetId = source.dataset.reachAsset;
    const asset = assetId ? assets.get(assetId) : undefined;
    if (assetId && asset) compiledAssetIds.add(assetId);
    if (source.tagName === 'IMG') {
      const style = view.getComputedStyle(source);
      const invalidStyles = [
        ...(style.transform !== 'none' ? [`transform=${style.transform}`] : []),
        ...(style.filter !== 'none' ? [`filter=${style.filter}`] : []),
        ...(style.clipPath !== 'none' && trustedMaskClips.get(source.id) !== style.clipPath
          ? [`clip-path=${style.clipPath}`]
          : []),
        ...(style.maskImage !== 'none' ? [`mask-image=${style.maskImage}`] : []),
        ...(
          [
            ['top-left', style.borderTopLeftRadius],
            ['top-right', style.borderTopRightRadius],
            ['bottom-left', style.borderBottomLeftRadius],
            ['bottom-right', style.borderBottomRightRadius],
          ] as const
        )
          .filter(([, value]) => parseFloat(value) !== 0)
          .map(([corner, value]) => `border-${corner}-radius=${value}`),
        ...(
          [
            ['top', style.borderTopWidth],
            ['right', style.borderRightWidth],
            ['bottom', style.borderBottomWidth],
            ['left', style.borderLeftWidth],
          ] as const
        )
          .filter(([, value]) => parseFloat(value) !== 0)
          .map(([side, value]) => `border-${side}-width=${value}`),
        ...(!['fill', 'contain', 'cover'].includes(style.objectFit)
          ? [`object-fit=${style.objectFit}`]
          : []),
      ];
      if (invalidStyles.length > 0)
        throw new HtmlLayoutValidationError(
          input.designContext
            ? `ASSET_STYLE: ${source.id.slice(0, 80)} unsupported ${invalidStyles.join('; ').slice(0, 300)}. ${REFERENCE_ASSET_REPAIR}`.slice(
                0,
                1400,
              )
            : 'Unsupported native asset image styling; keep the asset in an untransformed rectangular slot.',
        );
    }
    if (asset?.kind === 'scientificVisual') {
      existingIds.add(element.resourceId);
      slide.elements[index] = {
        ...asset.element,
        id: element.id,
        transform: element.transform,
        zIndex: element.zIndex,
      };
      const media = asset.resources ?? [];
      if (asset.element.manifest.resourceIds.some((id) => !media.some((item) => item.id === id)))
        throw new Error('Scientific visual references a missing trusted resource.');
      resources.push(...media);
    } else {
      const style = view.getComputedStyle(source);
      if (source.tagName === 'IMG') {
        if (style.objectPosition !== '50% 50%')
          throw new HtmlLayoutValidationError('Unsupported image object-position.');
        element.fit =
          style.objectFit === 'contain'
            ? 'contain'
            : style.objectFit === 'cover'
              ? 'cover'
              : 'stretch';
        const opacity = parseFloat(style.opacity);
        if (opacity < 1) element.opacity = opacity;
      }
      if (asset?.kind === 'image') {
        existingIds.add(element.resourceId);
        element.resourceId = asset.resource.id;
        element.alt = asset.alt ?? element.alt;
        resources.push(asset.resource);
        const maskId = source.dataset.reachAssetMask;
        if (asset.codeAnimation && !asset.isPlaceholder && maskId)
          throw new HtmlLayoutValidationError(
            'Code GIF must remain a native image slot; animation masks are unsupported.',
          );
        if (maskId) {
          if (!input.designContext)
            throw new HtmlLayoutValidationError(
              'Asset masks require the reference design protocol.',
            );
          const mask = getReferenceEntry('masks', maskId);
          if (!mask || mask.geometry.kind !== 'custom-path' || mask.geometry.pathCount !== 1)
            throw new HtmlLayoutValidationError(
              `Unknown or unsupported registered asset mask: ${maskId}`,
            );
          if (!asset.alt?.trim())
            throw new HtmlLayoutValidationError(
              `Masked teaching asset ${assetId} requires an alt description.`,
            );
          slide.elements[index] = {
            id: element.id,
            type: 'shape',
            transform: element.transform,
            zIndex: element.zIndex,
            ...(element.opacity === undefined ? {} : { opacity: element.opacity }),
            ariaLabel: asset.alt,
            geometry: { kind: 'custom', viewBox: mask.geometry.viewBox, path: mask.geometry.path },
            style: { fill: { kind: 'image', resourceId: asset.resource.id, mode: element.fit } },
          };
        }
        assetBindings.push({
          assetId: asset.assetId,
          elementId: element.id,
          binding: maskId ? 'shape-fill' : 'image-element',
        });
      }
    }
  }
  const pendingMedia = compiled.document.resources.media
    .filter((resource) => !existingIds.has(resource.id))
    .map((resource) => ({
      resourceId: resource.id,
      contentType: resource.contentType,
      dataUrl: compiled.resourceUrlsById[resource.id]!,
    }));
  if (compiledAssetIds.size !== assets.size)
    throw new HtmlLayoutValidationError('A required HTML asset is invisible or was not compiled.');
  if (slide.elements.length === 0)
    throw new HtmlLayoutValidationError(
      'HTML layout must contain at least one visible Native element.',
    );
  if (
    slide.elements.length > HTML_LAYOUT_LIMITS.nativeElements ||
    slide.elements.filter((element) => element.type === 'textFrame').length >
      HTML_LAYOUT_LIMITS.textElements ||
    pendingMedia.length + resources.length > HTML_LAYOUT_LIMITS.mediaResources
  )
    throw new HtmlLayoutValidationError(
      `HTML layout output element budget exceeded: native elements ${slide.elements.length}/${HTML_LAYOUT_LIMITS.nativeElements}, editable text elements ${slide.elements.filter((element) => element.type === 'textFrame').length}/${HTML_LAYOUT_LIMITS.textElements}, media resources ${pendingMedia.length + resources.length}/${HTML_LAYOUT_LIMITS.mediaResources}. Reduce the excess category while retaining all required assets.`,
    );
  const benignClipIds = new Set<string>();
  for (const warning of compiled.warnings) {
    if (warning.code !== 'OVERFLOW_CLIPPED' || !warning.nodeId) continue;
    const source = rendered.getElementById(warning.nodeId);
    const benignTextMetrics =
      source &&
      /^(H[1-6]|P|DIV)$/.test(source.tagName) &&
      !!source.textContent?.trim() &&
      !source.querySelector('figure,svg,img,div,p,h1,h2,h3,h4,h5,h6') &&
      textInkRects(rendered, source).every((ink) => !outside(ink, source.getBoundingClientRect()));
    if (source && (benignTextMetrics || isInlineVisualBaselineOverflow(rendered, source)))
      benignClipIds.add(warning.nodeId);
  }
  for (const message of compiled.diagnostics) {
    const warning = compiled.warnings.find((item) => message === `[${item.code}] ${item.message}`);
    if (warning?.code === 'OVERFLOW_CLIPPED' && benignClipIds.has(warning.nodeId ?? '')) continue;
    visualDiagnostics.report(warning?.nodeId ?? 'slide', message);
  }
  return {
    slide,
    resources,
    themes: input.designContext ? [createThemeResource(theme)] : compiled.document.resources.themes,
    pendingMedia,
    diagnostics: visualDiagnostics.diagnostics,
    elementIdMap,
    assetBindings,
  };
}

// The preserved demo compiler predates typed errors. Match only its explicit output contracts.
const preservedOutputContractErrors = new Set([
  '生成结果中没有 HTML。',
  '生成的 HTML 超过 300 KB 限制。',
  'HTML 画布没有可测量的尺寸。',
  'HTML 中没有可转换的文字、图形、视觉组或 SVG。',
  'HTML 元素超过 80 个的限制。',
]);

window.compileProductionHtml = async (input) => {
  try {
    return await compileProductionHtml(input);
  } catch (error) {
    if (error instanceof Error && preservedOutputContractErrors.has(error.message)) {
      throw new HtmlLayoutValidationError(error.message, { cause: error });
    }
    throw error;
  }
};
