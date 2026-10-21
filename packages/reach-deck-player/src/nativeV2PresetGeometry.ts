/**
 * Preset shape geometry for the native v2 renderer.
 *
 * Outlines follow the ECMA-376 presetShapeDefinitions formulas, evaluated in
 * the element's own pixel coordinate space so the resulting SVG path renders
 * 1:1 inside the transform box (viewBox = element width × height). Adjustment
 * values are the OOXML avLst `adj*` numbers (percent × 1000, i.e. 100000 = 1).
 *
 * Simple box presets (rect, roundRect, ellipse) stay on the CSS rendering path
 * and are not listed here as SVG paths.
 */

export interface PresetGeometrySvgPath {
  path: string;
  /**
   * Brace/bracket outlines are open stroke paths in OOXML (`fill="none"` on
   * the path element) and never take the shape fill.
   */
  fillMode: 'norm' | 'none';
}

type PresetAdjustments = Readonly<Record<string, number>> | undefined;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const fmt = (value: number) => `${Math.round(value * 1000) / 1000}`;

const adjustment = (adjustments: PresetAdjustments, name: string, fallback: number) => {
  const value = adjustments?.[name];
  return value === undefined || Number.isNaN(value) ? fallback : value;
};

/**
 * OOXML roundRect corner radius: min(w, h) × adj / 100000, adj defaulting to
 * 16667 (one sixth) and capped at 50000 (half the short side).
 */
export function roundRectCornerRadius(
  width: number,
  height: number,
  adjustments?: PresetAdjustments,
): number {
  const value = clamp(adjustment(adjustments, 'adj', 16_667), 0, 50_000);
  const radius = (Math.min(width, height) * value) / 100_000;
  return Math.round(radius * 1000) / 1000;
}

/**
 * ECMA-376 block arrows: adj1 is the shaft thickness as a fraction of the
 * cross axis, adj2 the head length as a fraction of the short side.
 */
function arrowMetrics(
  along: number,
  across: number,
  short: number,
  adjustments: PresetAdjustments,
): { headLength: number; halfShaft: number } {
  const a1 = clamp(adjustment(adjustments, 'adj1', 50_000), 0, 100_000);
  const maxA2 = short > 0 ? (100_000 * along) / short : 0;
  const a2 = clamp(adjustment(adjustments, 'adj2', 50_000), 0, maxA2);
  return {
    headLength: (short * a2) / 100_000,
    halfShaft: (across * a1) / 200_000,
  };
}

const pathBuilders: Readonly<
  Record<
    string,
    (width: number, height: number, adjustments: PresetAdjustments) => PresetGeometrySvgPath
  >
> = {
  rightArrow: (w, h, adjustments) => {
    const { headLength, halfShaft } = arrowMetrics(w, h, Math.min(w, h), adjustments);
    const x1 = w - headLength;
    const y1 = h / 2 - halfShaft;
    const y2 = h / 2 + halfShaft;
    return {
      path: `M 0 ${fmt(y1)} L ${fmt(x1)} ${fmt(y1)} L ${fmt(x1)} 0 L ${fmt(w)} ${fmt(h / 2)} L ${fmt(x1)} ${fmt(h)} L ${fmt(x1)} ${fmt(y2)} L 0 ${fmt(y2)} Z`,
      fillMode: 'norm',
    };
  },
  leftArrow: (w, h, adjustments) => {
    const { headLength, halfShaft } = arrowMetrics(w, h, Math.min(w, h), adjustments);
    const x1 = headLength;
    const y1 = h / 2 - halfShaft;
    const y2 = h / 2 + halfShaft;
    return {
      path: `M ${fmt(w)} ${fmt(y1)} L ${fmt(x1)} ${fmt(y1)} L ${fmt(x1)} 0 L 0 ${fmt(h / 2)} L ${fmt(x1)} ${fmt(h)} L ${fmt(x1)} ${fmt(y2)} L ${fmt(w)} ${fmt(y2)} Z`,
      fillMode: 'norm',
    };
  },
  upArrow: (w, h, adjustments) => {
    const { headLength, halfShaft } = arrowMetrics(h, w, Math.min(w, h), adjustments);
    const y1 = headLength;
    const x1 = w / 2 - halfShaft;
    const x2 = w / 2 + halfShaft;
    return {
      path: `M ${fmt(x1)} ${fmt(h)} L ${fmt(x1)} ${fmt(y1)} L 0 ${fmt(y1)} L ${fmt(w / 2)} 0 L ${fmt(w)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y1)} L ${fmt(x2)} ${fmt(h)} Z`,
      fillMode: 'norm',
    };
  },
  downArrow: (w, h, adjustments) => {
    const { headLength, halfShaft } = arrowMetrics(h, w, Math.min(w, h), adjustments);
    const y1 = h - headLength;
    const x1 = w / 2 - halfShaft;
    const x2 = w / 2 + halfShaft;
    return {
      path: `M ${fmt(x1)} 0 L ${fmt(x1)} ${fmt(y1)} L 0 ${fmt(y1)} L ${fmt(w / 2)} ${fmt(h)} L ${fmt(w)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y1)} L ${fmt(x2)} 0 Z`,
      fillMode: 'norm',
    };
  },
  triangle: (w, h, adjustments) => {
    const a = clamp(adjustment(adjustments, 'adj', 50_000), 0, 100_000);
    const apex = (w * a) / 100_000;
    return {
      path: `M 0 ${fmt(h)} L ${fmt(apex)} 0 L ${fmt(w)} ${fmt(h)} Z`,
      fillMode: 'norm',
    };
  },
  diamond: (w, h) => ({
    path: `M ${fmt(w / 2)} 0 L ${fmt(w)} ${fmt(h / 2)} L ${fmt(w / 2)} ${fmt(h)} L 0 ${fmt(h / 2)} Z`,
    fillMode: 'norm',
  }),
  parallelogram: (w, h, adjustments) => {
    const short = Math.min(w, h);
    const maxA = short > 0 ? (100_000 * w) / short : 0;
    const a = clamp(adjustment(adjustments, 'adj', 25_000), 0, maxA);
    const skew = (short * a) / 100_000;
    return {
      path: `M 0 ${fmt(h)} L ${fmt(skew)} 0 L ${fmt(w)} 0 L ${fmt(w - skew)} ${fmt(h)} Z`,
      fillMode: 'norm',
    };
  },
  trapezoid: (w, h, adjustments) => {
    const short = Math.min(w, h);
    const maxA = short > 0 ? (50_000 * w) / short : 0;
    const a = clamp(adjustment(adjustments, 'adj', 25_000), 0, maxA);
    const inset = (short * a) / 100_000;
    return {
      path: `M 0 ${fmt(h)} L ${fmt(inset)} 0 L ${fmt(w - inset)} 0 L ${fmt(w)} ${fmt(h)} Z`,
      fillMode: 'norm',
    };
  },
  leftBrace: (w, h, adjustments) => {
    const { curl, mid } = braceMetrics(w, h, adjustments);
    const x = w / 2;
    return {
      path:
        `M ${fmt(w)} 0 Q ${fmt(x)} 0 ${fmt(x)} ${fmt(curl)} L ${fmt(x)} ${fmt(mid - curl)} ` +
        `Q ${fmt(x)} ${fmt(mid)} 0 ${fmt(mid)} Q ${fmt(x)} ${fmt(mid)} ${fmt(x)} ${fmt(mid + curl)} ` +
        `L ${fmt(x)} ${fmt(h - curl)} Q ${fmt(x)} ${fmt(h)} ${fmt(w)} ${fmt(h)}`,
      fillMode: 'none',
    };
  },
  rightBrace: (w, h, adjustments) => {
    const { curl, mid } = braceMetrics(w, h, adjustments);
    const x = w / 2;
    return {
      path:
        `M 0 0 Q ${fmt(x)} 0 ${fmt(x)} ${fmt(curl)} L ${fmt(x)} ${fmt(mid - curl)} ` +
        `Q ${fmt(x)} ${fmt(mid)} ${fmt(w)} ${fmt(mid)} Q ${fmt(x)} ${fmt(mid)} ${fmt(x)} ${fmt(mid + curl)} ` +
        `L ${fmt(x)} ${fmt(h - curl)} Q ${fmt(x)} ${fmt(h)} 0 ${fmt(h)}`,
      fillMode: 'none',
    };
  },
  bracketPair: (w, h, adjustments) => {
    const short = Math.min(w, h);
    const a = clamp(adjustment(adjustments, 'adj', 16_667), 0, 50_000);
    const r = Math.min((short * a) / 100_000, w / 2, h / 2);
    return {
      path:
        `M ${fmt(r)} 0 Q 0 0 0 ${fmt(r)} L 0 ${fmt(h - r)} Q 0 ${fmt(h)} ${fmt(r)} ${fmt(h)} ` +
        `M ${fmt(w - r)} 0 Q ${fmt(w)} 0 ${fmt(w)} ${fmt(r)} L ${fmt(w)} ${fmt(h - r)} Q ${fmt(w)} ${fmt(h)} ${fmt(w - r)} ${fmt(h)}`,
      fillMode: 'none',
    };
  },
  chevron: (w, h, adjustments) => {
    const short = Math.min(w, h);
    const maxA = short > 0 ? (100_000 * w) / short : 0;
    const a = clamp(adjustment(adjustments, 'adj', 50_000), 0, maxA);
    const tip = (short * a) / 100_000;
    return {
      path: `M 0 0 L ${fmt(w - tip)} 0 L ${fmt(w)} ${fmt(h / 2)} L ${fmt(w - tip)} ${fmt(h)} L 0 ${fmt(h)} L ${fmt(tip)} ${fmt(h / 2)} Z`,
      fillMode: 'norm',
    };
  },
  rtTriangle: (w, h) => ({
    path: `M 0 ${fmt(h)} L 0 0 L ${fmt(w)} ${fmt(h)} Z`,
    fillMode: 'norm',
  }),
  star5: (w, h, adjustments) => {
    // 内点半径比 = adj / 50000(ECMA 默认 19098 ≈ 0.382);外点落在元素
    // 内切椭圆上,从正上方起每 72° 一个角。
    const a = clamp(adjustment(adjustments, 'adj', 19_098), 0, 50_000);
    const cx = w / 2;
    const cy = h / 2;
    const inner = a / 50_000;
    const points: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const outer = ((-90 + index * 72) * Math.PI) / 180;
      const between = ((-90 + 36 + index * 72) * Math.PI) / 180;
      points.push(`${fmt(cx + cx * Math.cos(outer))} ${fmt(cy + cy * Math.sin(outer))}`);
      points.push(
        `${fmt(cx + cx * inner * Math.cos(between))} ${fmt(cy + cy * inner * Math.sin(between))}`,
      );
    }
    return { path: `M ${points.join(' L ')} Z`, fillMode: 'norm' };
  },
  round2DiagRect: (w, h, adjustments) => {
    const short = Math.min(w, h);
    const r1 = Math.min(
      (short * clamp(adjustment(adjustments, 'adj1', 16_667), 0, 50_000)) / 100_000,
      w / 2,
      h / 2,
    );
    const r2 = Math.min(
      (short * clamp(adjustment(adjustments, 'adj2', 0), 0, 50_000)) / 100_000,
      w / 2,
      h / 2,
    );
    // 左上/右下用 adj1 圆角,右上/左下用 adj2(默认 0 = 直角)。
    return {
      path:
        `M ${fmt(r1)} 0 L ${fmt(w - r2)} 0 Q ${fmt(w)} 0 ${fmt(w)} ${fmt(r2)} ` +
        `L ${fmt(w)} ${fmt(h - r1)} Q ${fmt(w)} ${fmt(h)} ${fmt(w - r1)} ${fmt(h)} ` +
        `L ${fmt(r2)} ${fmt(h)} Q 0 ${fmt(h)} 0 ${fmt(h - r2)} ` +
        `L 0 ${fmt(r1)} Q 0 0 ${fmt(r1)} 0 Z`,
      fillMode: 'norm',
    };
  },
  wedgeRectCallout: (w, h, adjustments) => ({
    path: wedgeCalloutPath(w, h, adjustments, 0),
    fillMode: 'norm',
  }),
  wedgeRoundRectCallout: (w, h, adjustments) => ({
    path: wedgeCalloutPath(
      w,
      h,
      adjustments,
      Math.min(
        (Math.min(w, h) * clamp(adjustment(adjustments, 'adj3', 16_667), 0, 50_000)) / 100_000,
        w / 2,
        h / 2,
      ),
    ),
    fillMode: 'norm',
  }),
};

/**
 * Wedge callouts: a (rounded) rectangle body with a triangular tail whose
 * apex sits at (adj1, adj2) percent offsets from the shape centre. The tail
 * merges into the outline on the edge facing the apex's dominant direction —
 * an approximation of the ECMA edge-selection guides that matches the common
 * "tail below/beside the bubble" cases.
 */
function wedgeCalloutPath(
  w: number,
  h: number,
  adjustments: PresetAdjustments,
  radius: number,
): string {
  const r = Math.max(0, radius);
  const apexX = w / 2 + (w * adjustment(adjustments, 'adj1', -20_833)) / 100_000;
  const apexY = h / 2 + (h * adjustment(adjustments, 'adj2', 62_500)) / 100_000;
  const dx = apexX - w / 2;
  const dy = apexY - h / 2;
  // 尾巴基座半宽:ECMA 各分支取边长 1/12 左右的固定段。
  const vertical = Math.abs(dy) * w >= Math.abs(dx) * h;
  const halfBase = (vertical ? w : h) / 12;
  const edge: 'top' | 'bottom' | 'left' | 'right' | undefined = vertical
    ? dy < -h / 2
      ? 'top'
      : dy > h / 2
        ? 'bottom'
        : undefined
    : dx < -w / 2
      ? 'left'
      : dx > w / 2
        ? 'right'
        : undefined;
  const clampCentre = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  const cx = clampCentre(apexX, r + halfBase, w - r - halfBase);
  const cy = clampCentre(apexY, r + halfBase, h - r - halfBase);
  const top =
    edge === 'top'
      ? `L ${fmt(cx - halfBase)} 0 L ${fmt(apexX)} ${fmt(apexY)} L ${fmt(cx + halfBase)} 0 `
      : '';
  const right =
    edge === 'right'
      ? `L ${fmt(w)} ${fmt(cy - halfBase)} L ${fmt(apexX)} ${fmt(apexY)} L ${fmt(w)} ${fmt(cy + halfBase)} `
      : '';
  const bottom =
    edge === 'bottom'
      ? `L ${fmt(cx + halfBase)} ${fmt(h)} L ${fmt(apexX)} ${fmt(apexY)} L ${fmt(cx - halfBase)} ${fmt(h)} `
      : '';
  const left =
    edge === 'left'
      ? `L 0 ${fmt(cy + halfBase)} L ${fmt(apexX)} ${fmt(apexY)} L 0 ${fmt(cy - halfBase)} `
      : '';
  return (
    `M ${fmt(r)} 0 ${top}L ${fmt(w - r)} 0 ` +
    (r > 0 ? `Q ${fmt(w)} 0 ${fmt(w)} ${fmt(r)} ` : '') +
    `${right}L ${fmt(w)} ${fmt(h - r)} ` +
    (r > 0 ? `Q ${fmt(w)} ${fmt(h)} ${fmt(w - r)} ${fmt(h)} ` : '') +
    `${bottom}L ${fmt(r)} ${fmt(h)} ` +
    (r > 0 ? `Q 0 ${fmt(h)} 0 ${fmt(h - r)} ` : '') +
    `${left}L 0 ${fmt(r)} ` +
    (r > 0 ? `Q 0 0 ${fmt(r)} 0 ` : '') +
    'Z'
  );
}

/** adj1 = curl size (fraction of the short side), adj2 = tip vertical position. */
function braceMetrics(
  width: number,
  height: number,
  adjustments: PresetAdjustments,
): { curl: number; mid: number } {
  const short = Math.min(width, height);
  const a2 = clamp(adjustment(adjustments, 'adj2', 50_000), 0, 100_000);
  const mid = (height * a2) / 100_000;
  const a1 = clamp(adjustment(adjustments, 'adj1', 8_333), 0, 100_000);
  const curl = Math.min((short * a1) / 100_000, mid, height - mid);
  return { curl, mid };
}

/**
 * Presets the renderer paints through CSS box styling ('rectangle' is the
 * legacy alias accepted alongside OOXML 'rect').
 */
export const CSS_RENDERED_PRESET_GEOMETRIES: ReadonlySet<string> = new Set([
  'rect',
  'rectangle',
  'roundRect',
  'ellipse',
]);

export const NATIVE_V2_SUPPORTED_PRESET_GEOMETRIES: ReadonlySet<string> = new Set([
  ...CSS_RENDERED_PRESET_GEOMETRIES,
  ...Object.keys(pathBuilders),
]);

export function isSvgPathPresetGeometry(preset: string): boolean {
  return Object.prototype.hasOwnProperty.call(pathBuilders, preset);
}

export function presetGeometrySvgPath(
  preset: string,
  width: number,
  height: number,
  adjustments?: PresetAdjustments,
): PresetGeometrySvgPath | undefined {
  const builder = Object.prototype.hasOwnProperty.call(pathBuilders, preset)
    ? pathBuilders[preset]
    : undefined;
  return builder?.(width, height, adjustments);
}
