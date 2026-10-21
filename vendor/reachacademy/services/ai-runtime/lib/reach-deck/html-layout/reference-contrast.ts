import type { ReportLayoutDiagnostic } from './types';

type Sample = {
  element: Element;
  color: number[];
  minimum: number;
  rects: DOMRect[];
  text: boolean;
};
const luminance = (color: number[]) =>
  color
    .slice(0, 3)
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((total, v, i) => total + v * [0.2126, 0.7152, 0.0722][i]!, 0);

/** Measure against Chromium's actual composition with text ink temporarily removed. */
export async function checkReferenceContrast(
  document: Document,
  root: HTMLElement,
  consumePixels: (width: number, height: number) => void,
  report: ReportLayoutDiagnostic,
): Promise<void> {
  const hasInformativeGraphics = Array.from(
    root.querySelectorAll('[data-reach-informative="true"]'),
  ).some((element) => element.tagName !== 'TABLE');
  // Reserve every fixed raster in the caller's shared decoded-pixel ledger before allocation.
  for (let capture = 0; capture < (hasInformativeGraphics ? 4 : 3); capture++)
    consumePixels(1600, 900);
  const view = document.defaultView!;
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 900;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  };
  const samples: Sample[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const pseudo of ['::before', '::after']) {
      if (!['none', 'normal', '""'].includes(view.getComputedStyle(element, pseudo).content))
        report(
          element.closest('[id]')?.id ?? 'slide',
          'CONTRAST_UNMEASURABLE: use explicit editable text instead of generated pseudo content',
        );
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const element = node.parentElement!;
    if (!node.data.trim() || element.closest('style,script,.katex-mathml')) continue;
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible') continue;
    if (style.webkitTextFillColor !== style.color || parseFloat(style.webkitTextStrokeWidth) > 0)
      report(
        element.closest('[id]')?.id ?? 'slide',
        'CONTRAST_UNMEASURABLE: use the native text color without alternate text fill or stroke',
      );
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const s = view.getComputedStyle(ancestor);
      if (
        Number(s.opacity) !== 1 ||
        s.filter !== 'none' ||
        s.mixBlendMode !== 'normal' ||
        s.backdropFilter !== 'none'
      )
        report(
          element.closest('[id]')?.id ?? 'slide',
          `CONTRAST_UNMEASURABLE: ${(element.id || element.tagName).slice(0, 160)} uses opacity, blending or filters; use an opaque readable carrier`,
        );
    }
    const range = document.createRange();
    const rects: DOMRect[] = [];
    // Exclude spaces owned by this node, including wide word-spacing gaps containing other text.
    for (const match of node.data.matchAll(/\S+/gu)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      rects.push(...Array.from(range.getClientRects()));
    }
    if (element.closest('svg') && !/^rgb/.test(style.fill) && !style.fill.startsWith('#'))
      report(
        element.closest('[id]')?.id ?? 'slide',
        'CONTRAST_UNMEASURABLE: SVG text requires a solid text fill',
      );
    samples.push({
      element,
      color: rgba(element.closest('svg') ? style.fill : style.color),
      minimum:
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.666 && Number(style.fontWeight) >= 700)
          ? 3
          : 4.5,
      rects,
      text: true,
    });
  }
  const styles = new Map<HTMLElement, string | null>();
  try {
    // Freeze computed paint before changing color so currentColor backgrounds stay unchanged.
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    const paints = elements.map((element) => {
      const s = view.getComputedStyle(element);
      return {
        element,
        background: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        fill: s.fill,
        stroke: s.stroke,
        borders: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
      };
    });
    for (const { element, background, backgroundImage, borders, fill, stroke } of paints) {
      styles.set(element, element.getAttribute('style'));
      element.style.setProperty('background-color', background, 'important');
      element.style.setProperty('background-image', backgroundImage, 'important');
      ['top', 'right', 'bottom', 'left'].forEach((side, i) =>
        element.style.setProperty(`border-${side}-color`, borders[i]!, 'important'),
      );
      element.style.setProperty('color', 'transparent', 'important');
      element.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      element.style.setProperty('text-shadow', 'none', 'important');
      if (element.closest('svg')) {
        const text = /^(text|tspan)$/i.test(element.tagName);
        element.style.setProperty('fill', text ? 'transparent' : fill, 'important');
        element.style.setProperty('stroke', text ? 'transparent' : stroke, 'important');
      }
    }
    const capturePixels = async () => {
      const image = new Image();
      image.src = await window.captureLayoutRaster({ x: 0, y: 0, width: 1600, height: 900 });
      await image.decode();
      context.clearRect(0, 0, 1600, 900);
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, 1600, 900).data;
    };
    const paintText = (color: string) => {
      for (const element of elements) {
        element.style.setProperty('color', color, 'important');
        element.style.setProperty('-webkit-text-fill-color', color, 'important');
        if (element.closest('svg') && /^(text|tspan)$/i.test(element.tagName)) {
          element.style.setProperty('fill', color, 'important');
        }
      }
    };
    const pixels = await capturePixels();
    // Two fixed stage captures find actual glyph coverage, including originally invisible text.
    // Difference, rather than original ink/background difference, prevents same-color text bypass.
    const glyphMask = await (async () => {
      paintText('#000000');
      const black = await capturePixels();
      paintText('#ffffff');
      const white = await capturePixels();
      const mask = new Uint8Array(1600 * 900);
      for (let index = 0; index < mask.length; index++) {
        const offset = index * 4;
        mask[index] = Number(
          black[offset] !== white[offset] ||
            black[offset + 1] !== white[offset + 1] ||
            black[offset + 2] !== white[offset + 2],
        );
      }
      return mask;
    })();
    paintText('transparent');
    const graphicSamples: Sample[] = [];
    for (const element of root.querySelectorAll<HTMLElement>('[data-reach-informative="true"]')) {
      if (element.tagName === 'TABLE') continue;
      const original = paints.find((p) => p.element === element)!;
      if (
        element.textContent?.trim() ||
        element.children.length ||
        view.getComputedStyle(element).backgroundImage !== 'none'
      )
        report(
          element.closest('[id]')?.id ?? 'slide',
          'CONTRAST_UNMEASURABLE: informative graphics require a solid empty shape',
        );
      if (element.closest('svg') && !/^rgb/.test(original.fill) && !original.fill.startsWith('#'))
        report(
          element.closest('[id]')?.id ?? 'slide',
          'CONTRAST_UNMEASURABLE: informative SVG graphics require a solid fill',
        );
      graphicSamples.push({
        element,
        color: rgba(element.closest('svg') ? original.fill : original.background),
        minimum: 3,
        rects: [element.getBoundingClientRect()],
        text: false,
      });
      element.style.setProperty('visibility', 'hidden', 'important');
    }
    // At most one additional fixed capture, independent of the number of graphics or text nodes.
    const graphicPixels = graphicSamples.length === 0 ? pixels : await capturePixels();
    for (const table of root.querySelectorAll(
      'table[data-reach-informative="true"],table[data-reach-heatmap]',
    )) {
      const cells = Array.from(table.querySelectorAll('td,th')).map((cell) =>
        cell.getBoundingClientRect(),
      );
      const sampleCenter = (rect: DOMRect) => {
        const x = Math.floor((rect.left + rect.right) / 2);
        const y = Math.floor((rect.top + rect.bottom) / 2);
        if (x < 0 || x >= 1600 || y < 0 || y >= 900) {
          report(table.id, 'CONTRAST_UNMEASURABLE: heatmap cell center is outside the slide');
          return null;
        }
        const offset = (y * 1600 + x) * 4;
        if (pixels[offset + 3] !== 255)
          report(table.id, 'CONTRAST_UNMEASURABLE: heatmap cells require opaque colors');
        return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
      };
      for (let i = 0; i < cells.length; i++)
        for (const other of cells.slice(i + 1)) {
          const cell = cells[i]!;
          const adjacent =
            ((Math.abs(cell.right - other.left) <= 1 || Math.abs(other.right - cell.left) <= 1) &&
              Math.min(cell.bottom, other.bottom) > Math.max(cell.top, other.top)) ||
            ((Math.abs(cell.bottom - other.top) <= 1 || Math.abs(other.bottom - cell.top) <= 1) &&
              Math.min(cell.right, other.right) > Math.max(cell.left, other.left));
          if (!adjacent) continue;
          const first = sampleCenter(cell),
            second = sampleCenter(other);
          if (!first || !second) continue;
          if (first.every((v, index) => v === second[index])) continue;
          const a = luminance(first),
            b = luminance(second);
          if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 3)
            report(table.id, 'CONTRAST_LOW: adjacent informative table colors require 3:1');
        }
    }
    sampleLoop: for (const sample of [...samples, ...graphicSamples]) {
      const backgroundPixels = sample.text ? pixels : graphicPixels;
      let coveredPixels = 0;
      for (const rect of sample.rects) {
        for (
          let y = Math.max(0, Math.floor(rect.top));
          y < Math.min(900, Math.ceil(rect.bottom));
          y++
        ) {
          for (
            let x = Math.max(0, Math.floor(rect.left));
            x < Math.min(1600, Math.ceil(rect.right));
            x++
          ) {
            const offset = (y * 1600 + x) * 4;
            if (sample.text && glyphMask[y * 1600 + x] === 0) continue;
            coveredPixels++;
            if (backgroundPixels[offset + 3]! < 255) {
              report(
                sample.element.closest('[id]')?.id ?? 'slide',
                'CONTRAST_UNMEASURABLE: use an opaque slide background',
              );
              continue sampleLoop;
            }
            const background = [
              backgroundPixels[offset]!,
              backgroundPixels[offset + 1]!,
              backgroundPixels[offset + 2]!,
            ];
            const alpha = sample.color[3]! / 255;
            const foreground = background.map((v, i) => sample.color[i]! * alpha + v * (1 - alpha));
            const a = luminance(background),
              b = luminance(foreground);
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio + 0.01 < sample.minimum) {
              let owner = sample.element;
              while (owner.parentElement && owner.parentElement !== root)
                owner = owner.parentElement;
              const label = (owner.id || sample.element.id || sample.element.tagName).slice(0, 32);
              const excerpt = (sample.element.textContent ?? '').replace(/\s+/g, ' ').slice(0, 16);
              report(
                owner.id || 'slide',
                `CONTRAST_LOW: ${label} ${sample.element.tagName.slice(0, 12)} ${JSON.stringify(excerpt)} requires ${sample.minimum}:1; measured ${ratio.toFixed(2)}:1 at ${x},${y}; foreground rgba(${sample.color.join(',')}), background rgb(${background.join(',')})`,
              );
              // One location per sample is sufficient developer evidence.
              continue sampleLoop;
            }
          }
        }
      }
      if (sample.text && coveredPixels === 0) {
        report(
          sample.element.closest('[id]')?.id ?? 'slide',
          'CONTRAST_UNMEASURABLE: text has no visible glyph coverage',
        );
      }
    }
  } finally {
    for (const [element, style] of styles)
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
  }
}
