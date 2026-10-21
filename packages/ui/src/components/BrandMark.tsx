import type { SVGAttributes } from 'react';

import { cn } from '../cn';

/** 方形标志路径，与 `@reachany/brand/assets/logo-mark-*.svg` 一致（视口 250 250 580 580）。 */
const BRAND_MARK_PATH =
  'M830 486.04H767.51V767.5H557.34V827.53H830ZM312.51 252.47H528.96V312.5H312.51ZM250 312.5H312.51V528.96H250Z';

export type BrandMarkProps = Omit<SVGAttributes<SVGSVGElement>, 'children' | 'viewBox'>;

/**
 * 无垠学堂 / Reach Academy 方形标志（无字母）。填充色取 `currentColor`：
 * 深色 Header 上随文字为白色，浅色背景可用品牌红 `#ed0501`。默认装饰性（`aria-hidden`），
 * 品牌名称由相邻文字承载。
 */
export function BrandMark({ className, ...props }: BrandMarkProps) {
  return (
    <svg
      aria-hidden
      className={cn('rx-brand-mark', className)}
      fill="currentColor"
      focusable="false"
      viewBox="250 250 580 580"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d={BRAND_MARK_PATH} />
    </svg>
  );
}
