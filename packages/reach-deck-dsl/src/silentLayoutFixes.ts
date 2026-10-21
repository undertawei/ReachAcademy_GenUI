/**
 * v1 → v2 编译前的静默排版修正。
 *
 * "静默"＝不失败、不打断：每条规则只把明显越界的几何值拉回契约内，并留下一条
 * 中文说明，由调用方拼成 diagnostic。规则都是**纯函数**，不读时间、不生成随机
 * 值，同一输入必得同一输出（编译产物会被 sha256 成 revision token）。
 *
 * 舞台与安全区取自 layoutContract.ts，不在这里重新定义。
 */

import { DECK_SAFE_AREA, STANDARD_ELEMENT_GAP } from './layoutContract.js';
import type { DeckFrame } from './types.js';

/** 允许被吸附成标准间距的最大偏差（像素）。超过这个偏差视为作者的刻意留白。 */
export const GAP_SNAP_TOLERANCE = 8;

/** 文本自动缩放的下限：再小就低于可读阈值，宁可让文字溢出也不继续缩。 */
export const MINIMUM_TEXT_FONT_SCALE = 0.9;

export interface FrameClampResult {
  frame: DeckFrame;
  /** 中文修正说明；未做任何修正时为空数组。 */
  notes: string[];
}

export interface GapSnapEntry {
  id: string;
  frame: DeckFrame;
}

export interface GapSnapResult {
  frames: GapSnapEntry[];
  /** 中文修正说明（自带元素 id，因为吸附天然涉及两个元素）。 */
  diagnostics: string[];
}

export interface FontScaleClampResult {
  scale: number;
  notes: string[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * 把 frame 收进安全区。
 *
 * 顺序与契约一致：先平移回安全区内；若尺寸本身就超过安全区（平移救不回来），
 * 再收缩到安全区大小。收缩发生在平移之前计算，这样平移用的是收缩后的尺寸，
 * 结果一定完全落在安全区内。
 */
export function clampFrameIntoSafeArea(frame: DeckFrame): FrameClampResult {
  const notes: string[] = [];
  const width = Math.min(frame.width, DECK_SAFE_AREA.width);
  const height = Math.min(frame.height, DECK_SAFE_AREA.height);
  const x = Math.min(
    Math.max(frame.x, DECK_SAFE_AREA.x),
    DECK_SAFE_AREA.x + DECK_SAFE_AREA.width - width,
  );
  const y = Math.min(
    Math.max(frame.y, DECK_SAFE_AREA.y),
    DECK_SAFE_AREA.y + DECK_SAFE_AREA.height - height,
  );

  if (x !== frame.x || y !== frame.y) {
    notes.push(
      `超出安全区，已从 (${round2(frame.x)}, ${round2(frame.y)}) 平移到 (${round2(x)}, ${round2(y)})`,
    );
  }
  if (width !== frame.width || height !== frame.height) {
    notes.push(
      `尺寸 ${round2(frame.width)}×${round2(frame.height)} 超过安全区，已收缩为 ${round2(width)}×${round2(height)}`,
    );
  }
  if (notes.length === 0) return { frame, notes };
  return { frame: { ...frame, x, y, width, height }, notes };
}

/**
 * 把接近标准间距的相邻间距吸附为 `STANDARD_ELEMENT_GAP`。
 *
 * 策略刻意保持最简、可预测：
 * 1. 分纵、横两轴各扫一遍；纵轴只看水平投影有重叠的元素对，横轴反之。
 * 2. 每个元素只与它在该轴上**最近的**前驱构成一对，避免同一元素被多次拉扯。
 * 3. 只移动后 / 下方的那个元素。
 * 4. 移动后若会离开安全区则放弃该次吸附 —— 安全区约束优先于间距美观。
 *
 * **排序、邻居查找与间距计算一律读入参的原始坐标**，位移只写进输出。否则前驱被
 * 吸附后会改变后继的间距判定，位移沿链条传播：A/B/C 三个竖排元素里 C 与 B 原本
 * 就是标准间距、本不该动，却会因为 B 上移 6px 而被判成 30 跟着上移。
 */
export function snapStandardGaps(entries: readonly GapSnapEntry[]): GapSnapResult {
  // 判定基准：全程只读这份原始坐标。
  const originalFrames = new Map(entries.map((entry) => [entry.id, entry.frame] as const));
  // 输出：被吸附的元素写在这里，不参与任何判定。
  const snappedFrames = new Map<string, DeckFrame>();
  const diagnostics: string[] = [];

  const axes = [
    {
      label: '垂直',
      start: (frame: DeckFrame) => frame.y,
      size: (frame: DeckFrame) => frame.height,
      crossStart: (frame: DeckFrame) => frame.x,
      crossSize: (frame: DeckFrame) => frame.width,
      shift: (frame: DeckFrame, delta: number): DeckFrame => ({ ...frame, y: frame.y + delta }),
    },
    {
      label: '水平',
      start: (frame: DeckFrame) => frame.x,
      size: (frame: DeckFrame) => frame.width,
      crossStart: (frame: DeckFrame) => frame.y,
      crossSize: (frame: DeckFrame) => frame.height,
      shift: (frame: DeckFrame, delta: number): DeckFrame => ({ ...frame, x: frame.x + delta }),
    },
  ] as const;

  for (const axis of axes) {
    // 排序键固定为 (轴向起点, 交叉轴起点, id)，保证同坐标元素的处理顺序确定。
    const ordered = [...entries]
      .map((entry) => entry.id)
      .sort((left, right) => {
        const leftFrame = originalFrames.get(left)!;
        const rightFrame = originalFrames.get(right)!;
        return (
          axis.start(leftFrame) - axis.start(rightFrame) ||
          axis.crossStart(leftFrame) - axis.crossStart(rightFrame) ||
          (left < right ? -1 : left > right ? 1 : 0)
        );
      });

    for (let index = 0; index < ordered.length; index += 1) {
      const targetId = ordered[index]!;
      const target = originalFrames.get(targetId)!;

      // 找该轴上最近的前驱：完全位于目标之前，且交叉轴投影有重叠。
      let neighbourId: string | undefined;
      let neighbourEnd = Number.NEGATIVE_INFINITY;
      for (const candidateId of ordered) {
        if (candidateId === targetId) continue;
        const candidate = originalFrames.get(candidateId)!;
        const candidateEnd = axis.start(candidate) + axis.size(candidate);
        if (candidateEnd > axis.start(target)) continue;
        const overlaps =
          axis.crossStart(candidate) < axis.crossStart(target) + axis.crossSize(target) &&
          axis.crossStart(target) < axis.crossStart(candidate) + axis.crossSize(candidate);
        if (!overlaps) continue;
        if (candidateEnd > neighbourEnd) {
          neighbourEnd = candidateEnd;
          neighbourId = candidateId;
        }
      }
      if (neighbourId === undefined) continue;

      const gap = axis.start(target) - neighbourEnd;
      const delta = STANDARD_ELEMENT_GAP - gap;
      if (delta === 0 || Math.abs(delta) > GAP_SNAP_TOLERANCE) continue;

      // 同一元素可能在两个轴上各被吸附一次，因此以已写入的结果为位移起点。
      const current = snappedFrames.get(targetId) ?? target;
      const shifted = axis.shift(current, delta);
      const clamped = clampFrameIntoSafeArea(shifted);
      if (clamped.notes.length > 0) continue;

      snappedFrames.set(targetId, shifted);
      diagnostics.push(
        `元素 ${targetId}：与元素 ${neighbourId} 的${axis.label}间距 ${round2(gap)} 与标准间距 ${STANDARD_ELEMENT_GAP} 相差不超过 ${GAP_SNAP_TOLERANCE}，已吸附为 ${STANDARD_ELEMENT_GAP}`,
      );
    }
  }

  return {
    frames: entries.map((entry) => ({
      id: entry.id,
      frame: snappedFrames.get(entry.id) ?? entry.frame,
    })),
    diagnostics,
  };
}

/**
 * 把文本自动缩放系数收进 `[MINIMUM_TEXT_FONT_SCALE, 1]`。
 *
 * v2 的 `autofit.fontScale` 取值域是 (0, 1]；低于 0.9 的缩放在 1600×900 舞台上
 * 已经影响可读性，统一抬到 0.9 —— 宁可文字溢出被看见，也不要缩到看不清。
 */
export function clampTextFontScale(scale: number): FontScaleClampResult {
  if (!Number.isFinite(scale) || scale <= 0) {
    return { scale: 1, notes: [`字号缩放 ${scale} 不是有效比例，已回退为 1`] };
  }
  if (scale > 1) return { scale: 1, notes: [`字号缩放 ${round2(scale)} 大于 1，已回退为 1`] };
  if (scale < MINIMUM_TEXT_FONT_SCALE) {
    return {
      scale: MINIMUM_TEXT_FONT_SCALE,
      notes: [
        `字号缩放 ${round2(scale)} 低于下限 ${MINIMUM_TEXT_FONT_SCALE}，已抬到 ${MINIMUM_TEXT_FONT_SCALE}`,
      ],
    };
  }
  return { scale: round2(scale), notes: [] };
}
