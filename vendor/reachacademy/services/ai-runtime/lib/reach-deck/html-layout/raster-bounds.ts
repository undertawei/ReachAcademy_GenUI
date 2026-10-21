/** Chromium's finite blur paint extends about three Gaussian sigmas (blur / 2). */
export function shadowRasterBounds(rect: DOMRect, boxShadow: string): DOMRect {
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;
  for (const shadow of boxShadow.split(/,(?![^()]*\))/)) {
    if (shadow === 'none' || /\binset\b/.test(shadow)) continue;
    const lengths = shadow.match(/-?(?:\d*\.)?\d+px/g)?.map(Number.parseFloat);
    if (!lengths || lengths.length < 2 || lengths.some((value) => !Number.isFinite(value)))
      continue;
    const [dx, dy, blur = 0, spread = 0] = lengths;
    const extent = Math.max(0, Math.max(0, blur) * 1.5 + spread);
    left = Math.min(left, Math.floor(rect.left + dx! - extent));
    top = Math.min(top, Math.floor(rect.top + dy! - extent));
    right = Math.max(right, Math.ceil(rect.right + dx! + extent));
    bottom = Math.max(bottom, Math.ceil(rect.bottom + dy! + extent));
  }
  return new DOMRect(left, top, right - left, bottom - top);
}
