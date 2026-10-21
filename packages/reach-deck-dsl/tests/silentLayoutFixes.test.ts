import { describe, expect, it } from 'vitest';

import { DECK_SAFE_AREA, STANDARD_ELEMENT_GAP } from '../src/layoutContract.js';
import {
  MINIMUM_TEXT_FONT_SCALE,
  clampFrameIntoSafeArea,
  clampTextFontScale,
  snapStandardGaps,
} from '../src/silentLayoutFixes.js';

describe('clampFrameIntoSafeArea', () => {
  it('安全区内的 frame 原样返回且不产生说明', () => {
    const frame = { x: 200, y: 200, width: 400, height: 300 };
    const result = clampFrameIntoSafeArea(frame);
    expect(result.frame).toBe(frame);
    expect(result.notes).toEqual([]);
  });

  it('贴着安全区边界的 frame 不算越界', () => {
    const frame = {
      x: DECK_SAFE_AREA.x,
      y: DECK_SAFE_AREA.y,
      width: DECK_SAFE_AREA.width,
      height: DECK_SAFE_AREA.height,
    };
    expect(clampFrameIntoSafeArea(frame).notes).toEqual([]);
  });

  it('越界但放得下的 frame 只平移', () => {
    const result = clampFrameIntoSafeArea({ x: 1500, y: 800, width: 200, height: 100 });
    expect(result.frame).toEqual({ x: 1320, y: 736, width: 200, height: 100 });
    expect(result.notes).toEqual(['超出安全区，已从 (1500, 800) 平移到 (1320, 736)']);
  });

  it('尺寸超过安全区的 frame 先平移再收缩', () => {
    const result = clampFrameIntoSafeArea({ x: 0, y: 0, width: 2000, height: 900 });
    expect(result.frame).toEqual({ x: 80, y: 64, width: 1440, height: 772 });
    expect(result.notes).toEqual([
      '超出安全区，已从 (0, 0) 平移到 (80, 64)',
      '尺寸 2000×900 超过安全区，已收缩为 1440×772',
    ]);
  });

  it('保留 rotation 等未参与修正的字段', () => {
    const result = clampFrameIntoSafeArea({ x: 0, y: 0, width: 200, height: 100, rotation: 15 });
    expect(result.frame.rotation).toBe(15);
  });
});

describe('snapStandardGaps', () => {
  const above = { id: 'above', frame: { x: 100, y: 100, width: 400, height: 100 } };

  it('把偏差在容差内的垂直间距吸附为标准间距，且只移动下方元素', () => {
    const below = { id: 'below', frame: { x: 100, y: 230, width: 400, height: 100 } };
    const result = snapStandardGaps([above, below]);
    expect(result.frames[0]!.frame).toEqual(above.frame);
    expect(result.frames[1]!.frame).toEqual({ x: 100, y: 224, width: 400, height: 100 });
    expect(result.diagnostics).toEqual([
      `元素 below：与元素 above 的垂直间距 30 与标准间距 ${STANDARD_ELEMENT_GAP} 相差不超过 8，已吸附为 ${STANDARD_ELEMENT_GAP}`,
    ]);
  });

  it('偏差超过容差时不吸附', () => {
    const below = { id: 'below', frame: { x: 100, y: 250, width: 400, height: 100 } };
    const result = snapStandardGaps([above, below]);
    expect(result.frames[1]!.frame).toEqual(below.frame);
    expect(result.diagnostics).toEqual([]);
  });

  it('已经是标准间距时不产生修正', () => {
    const below = { id: 'below', frame: { x: 100, y: 224, width: 400, height: 100 } };
    expect(snapStandardGaps([above, below]).diagnostics).toEqual([]);
  });

  it('交叉轴没有重叠的元素不构成相邻对', () => {
    const beside = { id: 'beside', frame: { x: 900, y: 230, width: 400, height: 100 } };
    const result = snapStandardGaps([above, beside]);
    expect(result.frames[1]!.frame).toEqual(beside.frame);
    expect(result.diagnostics).toEqual([]);
  });

  it('吸附水平间距', () => {
    const left = { id: 'left', frame: { x: 100, y: 100, width: 200, height: 100 } };
    const right = { id: 'right', frame: { x: 328, y: 100, width: 200, height: 100 } };
    const result = snapStandardGaps([left, right]);
    expect(result.frames[1]!.frame).toEqual({ x: 324, y: 100, width: 200, height: 100 });
    expect(result.diagnostics).toHaveLength(1);
  });

  it('前驱被吸附不影响后继判定：原本已是标准间距的元素不动', () => {
    // B 与 A 间距 30 → 上移 6px 吸附；C 与 B 的**原始**间距恰好是 24，本就达标。
    // 若判定读的是已更新坐标，C 会被误判成间距 30 而跟着上移到 348。
    const b = { id: 'B', frame: { x: 100, y: 230, width: 400, height: 100 } };
    const c = { id: 'C', frame: { x: 100, y: 354, width: 400, height: 100 } };
    const result = snapStandardGaps([above, b, c]);
    expect(result.frames[1]!.frame.y).toBe(224);
    expect(result.frames[2]!.frame).toEqual(c.frame);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('竖排链上每个元素只按自己的原始间距吸附，位移不累加', () => {
    // 5 个初始间距均为 30 的元素：每个都相对**原始**前驱上移 6px，不沿链条累积，
    // 也不出现 0/-6 交替传播。
    const entries = [0, 1, 2, 3, 4].map((index) => ({
      id: `E${index}`,
      frame: { x: 100, y: 100 + index * 130, width: 400, height: 100 },
    }));
    const result = snapStandardGaps(entries);
    expect(result.frames.map((entry) => entry.frame.y)).toEqual([100, 224, 354, 484, 614]);
    expect(result.diagnostics).toHaveLength(4);
  });

  it('输出与输入顺序一致，未被吸附的元素返回原 frame 引用', () => {
    const lone = { id: 'lone', frame: { x: 100, y: 100, width: 400, height: 100 } };
    const result = snapStandardGaps([lone]);
    expect(result.frames[0]!.frame).toBe(lone.frame);
  });

  it('吸附会把元素推出安全区时放弃该次吸附', () => {
    const top = { id: 'top', frame: { x: 100, y: 64, width: 400, height: 654 } };
    // tail 底边正好压在安全区下沿，向下吸附 6px 就会越界。
    const tail = { id: 'tail', frame: { x: 100, y: 736, width: 400, height: 100 } };
    const result = snapStandardGaps([top, tail]);
    expect(result.frames[1]!.frame).toEqual(tail.frame);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('clampTextFontScale', () => {
  it('区间内的缩放原样保留', () => {
    expect(clampTextFontScale(0.95)).toEqual({ scale: 0.95, notes: [] });
    expect(clampTextFontScale(1)).toEqual({ scale: 1, notes: [] });
  });

  it('低于下限的缩放被抬到 0.9', () => {
    const result = clampTextFontScale(0.8);
    expect(result.scale).toBe(MINIMUM_TEXT_FONT_SCALE);
    expect(result.notes).toEqual(['字号缩放 0.8 低于下限 0.9，已抬到 0.9']);
  });

  it('大于 1 或非法的缩放回退为 1', () => {
    expect(clampTextFontScale(1.2).scale).toBe(1);
    expect(clampTextFontScale(0).scale).toBe(1);
    expect(clampTextFontScale(Number.NaN).scale).toBe(1);
  });
});
