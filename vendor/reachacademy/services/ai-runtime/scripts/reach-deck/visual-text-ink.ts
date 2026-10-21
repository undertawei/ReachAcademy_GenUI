/** Self-contained browser callback: retained line-box diagnostics are not necessarily painted overflow. */
export function inspectTextFrameInk(nodes: Element[]) {
  const canvas = document.createElement('canvas').getContext('2d');
  return nodes.map((node) => {
    const bounds = node.getBoundingClientRect();
    const host = node as HTMLElement;
    const scaleX = bounds.width / host.offsetWidth;
    const scaleY = bounds.height / host.offsetHeight;
    const hostStyle = getComputedStyle(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let glyphCount = 0;
    let inkOutside = false;
    let measurable = Boolean(canvas && scaleX > 0 && scaleY > 0);
    const inkBounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      const parent = text.parentElement;
      if (!text.data.trim() || !parent || parent.closest('.katex-mathml')) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
        continue;
      if (style.writingMode !== 'horizontal-tb' || style.transform !== 'none') {
        measurable = false;
        continue;
      }
      if (!canvas) continue;
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        text.data,
      )) {
        if (!part.segment.trim()) continue;
        const value =
          style.textTransform === 'uppercase'
            ? part.segment.toUpperCase()
            : style.textTransform === 'lowercase'
              ? part.segment.toLowerCase()
              : part.segment;
        const metrics = canvas.measureText(value);
        const range = document.createRange();
        range.setStart(text, part.index);
        range.setEnd(text, part.index + part.segment.length);
        for (const rect of range.getClientRects()) {
          const baseline = rect.top + metrics.fontBoundingBoxAscent * scaleY;
          const ink = {
            left: rect.left - metrics.actualBoundingBoxLeft * scaleX,
            right: rect.left + metrics.actualBoundingBoxRight * scaleX,
            top: baseline - metrics.actualBoundingBoxAscent * scaleY,
            bottom: baseline + metrics.actualBoundingBoxDescent * scaleY,
          };
          if (!Object.values(ink).every(Number.isFinite)) {
            measurable = false;
            continue;
          }
          glyphCount++;
          inkBounds.left = Math.min(inkBounds.left, ink.left);
          inkBounds.right = Math.max(inkBounds.right, ink.right);
          inkBounds.top = Math.min(inkBounds.top, ink.top);
          inkBounds.bottom = Math.max(inkBounds.bottom, ink.bottom);
          if (
            ink.left < bounds.left - 1 ||
            ink.right > bounds.right + 1 ||
            ink.top < bounds.top - 1 ||
            ink.bottom > bounds.bottom + 1
          )
            inkOutside = true;
        }
      }
    }
    return {
      elementId: node
        .closest('[data-native-v2-element-id]')
        ?.getAttribute('data-native-v2-element-id'),
      overflow: node.getAttribute('data-native-v2-text-overflow'),
      glyphCount,
      inkBounds: glyphCount ? inkBounds : null,
      visibleGlyphInkOutside: inkOutside,
      lineBoxOnly:
        measurable &&
        glyphCount > 0 &&
        !inkOutside &&
        hostStyle.overflowX === 'visible' &&
        hostStyle.overflowY === 'visible',
    };
  });
}
