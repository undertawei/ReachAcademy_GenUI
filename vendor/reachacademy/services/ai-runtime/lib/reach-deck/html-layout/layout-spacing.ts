import type { ReportLayoutDiagnostic } from './types';
import { shadowRasterBounds } from './raster-bounds';

/** Advisory geometry checks: keep authored coordinates intact and expose source-layout defects. */
export function checkSlideSpacing(
  document: Document,
  root: HTMLElement,
  report: ReportLayoutDiagnostic,
): void {
  const view = document.defaultView!;
  const stage = root.getBoundingClientRect();
  const visible = (element: Element) => {
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const painted = (element: Element) => {
    const s = view.getComputedStyle(element);
    const colorVisible = (value: string) =>
      value !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(value);
    return (
      colorVisible(s.backgroundColor) ||
      s.backgroundImage !== 'none' ||
      (['Top', 'Right', 'Bottom', 'Left'] as const).some(
        (side) =>
          parseFloat(s[`border${side}Width`]) > 0 &&
          s[`border${side}Style`] !== 'none' &&
          colorVisible(s[`border${side}Color`]),
      )
    );
  };
  const children = Array.from(root.children).filter(visible);
  // Only independent editable text is subject to the safe area. Full-bleed art is intentional.
  for (const element of children) {
    if (
      !/^(H[1-6]|P|DIV)$/.test(element.tagName) ||
      !element.textContent?.trim() ||
      element.hasAttribute('data-reach-asset') ||
      element.querySelector('figure,svg,img,table,div,p,h1,h2,h3,h4,h5,h6')
    )
      continue;
    const rect = element.getBoundingClientRect();
    const bottomMargin = stage.bottom - rect.bottom;
    if (rect.top >= stage.top + stage.height * 0.75 && bottomMargin < 24) {
      report(
        element.id,
        `FOOTER_SAFE_AREA: ${element.id} leaves ${Math.round(bottomMargin)}px below its text frame; reserve at least 24px inside the slide.`,
      );
    }
  }
  // Long, thin lower-page dividers are a boundary, not an ordinary overlapping card decoration.
  const dividers = children.filter((element) => {
    const r = element.getBoundingClientRect();
    const explicitFooter =
      element.matches('footer,[role="contentinfo"]') ||
      /(?:^|[-_\s])footer(?:$|[-_\s])|页脚/i.test(
        `${element.id} ${element.getAttribute('aria-label') ?? ''}`,
      );
    // Sibling drawings have no DOM parent relationship. A line well inside a
    // painted card is an internal separator/timeline, not a page boundary.
    // Explicit footer semantics still win, including a mistakenly overlapping card.
    const internalSeparator =
      !explicitFooter &&
      children.some((card) => {
        if (card === element || card.textContent?.trim() || !painted(card)) return false;
        const box = card.getBoundingClientRect();
        return (
          box.width >= 80 &&
          box.height >= 48 &&
          !(box.width >= stage.width * 0.95 && box.height >= stage.height * 0.95) &&
          r.left >= box.left + 12 &&
          r.right <= box.right - 12 &&
          r.top >= box.top + 12 &&
          r.bottom <= box.bottom - 12
        );
      });
    return (
      !internalSeparator &&
      !element.textContent?.trim() &&
      !element.hasAttribute('data-reach-asset') &&
      painted(element) &&
      r.height <= 4 &&
      r.width >= stage.width * 0.5 &&
      r.top >= stage.top + stage.height * 0.75
    );
  });
  for (const divider of dividers) {
    const boundary = divider.getBoundingClientRect();
    for (const element of children) {
      if (element === divider || element.contains(divider) || !painted(element)) continue;
      const r = element.getBoundingClientRect();
      if (
        r.width < 80 ||
        r.height < 48 ||
        (r.width >= stage.width * 0.95 && r.height >= stage.height * 0.95)
      )
        continue;
      const overlapX = Math.min(r.right, boundary.right) - Math.max(r.left, boundary.left);
      if (overlapX > 1 && r.top < boundary.top - 1 && r.bottom > boundary.top + 1) {
        report(
          element.id,
          `FOOTER_CARD_INTERSECTION: ${element.id} crosses ${divider.id} by ${Math.round(r.bottom - boundary.top)}px; keep the card and its decoration above the footer divider with a visible gap.`,
        );
      } else if (overlapX > 1 && r.bottom <= boundary.top) {
        const paint = shadowRasterBounds(r, view.getComputedStyle(element).boxShadow);
        if (paint.bottom > boundary.top + 1)
          report(
            element.id,
            `FOOTER_SHADOW_INTERSECTION: ${element.id} shadow reaches across ${divider.id}; reserve space for its paint outside the card bounds.`,
          );
      }
    }
  }
}
