import type { CSSProperties, SVGAttributes } from 'react';

import { cn } from '../cn';

export type BrandLoaderSize = 'lg' | 'md' | 'sm';

export type BrandLoaderProps = Omit<SVGAttributes<SVGSVGElement>, 'children' | 'viewBox'> & {
  label?: string;
  size?: BrandLoaderSize;
};

/**
 * 标志笔画所在的方环中线，顺时针连续五圈，起点在左上角开口处。
 *
 * 标志的竖笔画厚 62.5、横笔画厚 60.03；外层 `scale(1 0.96048)` 把横向笔画压到 60.03，
 * 于是在局部坐标里统一用 62.5 的描边即可逐像素还原标志。动画中笔画头部要转三圈，
 * 加上起点和伸长量，五圈足够让每段笔画始终落在路径中段：拐角都有斜接，不会在路径
 * 起止点被切成两截。
 */
const LOOP_PATH = `M281.26 294.11${'H798.76V830.33H281.26V294.11'.repeat(5)}`;

/** 三段笔画在方环上的起点与长度（局部坐标）：上横、右下拐角、左竖；关键帧见 feedback.css。 */
const SEGMENTS = [
  { length: 216.45, name: 'top', offset: 31.25 },
  { length: 565.71, name: 'corner', offset: 729.43 },
  { length: 225.37, name: 'side', offset: 1850.83 },
] as const;

/**
 * 品牌加载动画：标志的三段笔画起步时向后拉长，沿隐含的方框顺时针高速转三圈，
 * 转圈时各自伸缩、节奏错开；随后缓停，拖尾追上头部收拢回标志原形，停顿片刻后循环。
 * 颜色取 `currentColor`；减少动效时静止显示标志，需配合文字或 `aria-busy`。
 */
export function BrandLoader({ className, label, size = 'md', ...props }: BrandLoaderProps) {
  return (
    <svg
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      className={cn('rx-brand-loader', `rx-brand-loader-${size}`, className)}
      focusable="false"
      role={label === undefined ? undefined : 'status'}
      viewBox="250 250 580 580"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g transform="scale(1 0.96048)">
        {SEGMENTS.map((segment) => (
          <path
            className={`rx-brand-loader-stroke rx-brand-loader-stroke-${segment.name}`}
            d={LOOP_PATH}
            key={segment.name}
            style={
              {
                '--rx-brand-loader-length': `${segment.length}px`,
                '--rx-brand-loader-offset': `${segment.offset}px`,
              } as CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
}
