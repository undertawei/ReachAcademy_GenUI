/**
 * 画布吸附：舞台边缘/中线与其他元素的边缘/中心作为参考线，v1 幻灯片与
 * 原生 v2 幻灯片共用同一套实现，保证两种画布的手感完全一致。
 */
export type StageRect = { x: number; y: number; width: number; height: number };
export type AlignmentGuides = { vertical: number[]; horizontal: number[] };

export const SNAP_THRESHOLD = 6;
/** 旋转只咬合水平/垂直四个方位，其余角度保持自由，避免误吸。 */
export const ROTATION_SNAP_THRESHOLD = 5;
export const EMPTY_GUIDES: AlignmentGuides = { vertical: [], horizontal: [] };

export const roundedStageValue = (value: number, precision = 1) => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

/** 收集吸附参考线：舞台边缘/中线 + 未被拖动元素的边缘与中心。 */
export function collectSnapLines(
  boxes: Array<{ id: string; box: StageRect }>,
  movingIds: Set<string>,
  stageWidth: number,
  stageHeight: number,
): AlignmentGuides {
  const vertical = [0, stageWidth / 2, stageWidth];
  const horizontal = [0, stageHeight / 2, stageHeight];
  for (const entry of boxes) {
    if (movingIds.has(entry.id)) continue;
    const { x, y, width, height } = entry.box;
    vertical.push(x, x + width / 2, x + width);
    horizontal.push(y, y + height / 2, y + height);
  }
  return { vertical, horizontal };
}

/** 在候选线中找与任一关键位置（边缘/中心）距离最近且在阈值内的吸附偏移。 */
function snapAxis(positions: number[], lines: number[]): { offset: number; line?: number } {
  let best: { offset: number; line: number } | undefined;
  for (const position of positions) {
    for (const line of lines) {
      const offset = line - position;
      if (
        Math.abs(offset) <= SNAP_THRESHOLD &&
        (best === undefined || Math.abs(offset) < Math.abs(best.offset))
      ) {
        best = { offset, line };
      }
    }
  }
  return best ?? { offset: 0 };
}

export function snapMovingBox(
  box: StageRect,
  lines: AlignmentGuides,
): { dx: number; dy: number; guides: AlignmentGuides } {
  const snapX = snapAxis([box.x, box.x + box.width / 2, box.x + box.width], lines.vertical);
  const snapY = snapAxis([box.y, box.y + box.height / 2, box.y + box.height], lines.horizontal);
  return {
    dx: snapX.offset,
    dy: snapY.offset,
    guides: {
      vertical: snapX.line === undefined ? [] : [snapX.line],
      horizontal: snapY.line === undefined ? [] : [snapY.line],
    },
  };
}

/**
 * 旋转吸附：先归一到 (-180, 180]，再在阈值内咬合水平（0/180）与垂直
 * （±90）方位；命中时回报 axis，供画布亮出对应的中线。
 */
export function snapRotation(rotation: number): {
  rotation: number;
  axis?: 'horizontal' | 'vertical';
} {
  const normalized = ((((rotation + 180) % 360) + 360) % 360) - 180;
  const axes = [
    { angle: 0, axis: 'horizontal' as const },
    { angle: 180, axis: 'horizontal' as const },
    { angle: -180, axis: 'horizontal' as const },
    { angle: 90, axis: 'vertical' as const },
    { angle: -90, axis: 'vertical' as const },
  ];
  for (const candidate of axes) {
    if (Math.abs(normalized - candidate.angle) <= ROTATION_SNAP_THRESHOLD) {
      return { rotation: candidate.angle === -180 ? 180 : candidate.angle, axis: candidate.axis };
    }
  }
  return { rotation: roundedStageValue(normalized) };
}
