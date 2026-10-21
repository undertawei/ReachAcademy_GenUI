'use client';

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';

import { cn } from '../cn';
import { usePrefersReducedMotion } from '../primitives/usePrefersReducedMotion';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function readMotionToken(name: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function readDuration(name: string): number {
  const raw = readMotionToken(name);
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith('ms') ? value : value * 1000;
}

/** 把 `cubic-bezier(x1, y1, x2, y2)` token 解析成缓动函数；解析失败时退回线性。 */
function readEasing(name: string): (t: number) => number {
  const match = /cubic-bezier\(([^)]+)\)/.exec(readMotionToken(name));
  const points = match?.[1]?.split(',').map((part) => parseFloat(part));
  if (!points || points.length !== 4 || points.some((point) => !Number.isFinite(point))) {
    return (t) => t;
  }
  const [x1, y1, x2, y2] = points as [number, number, number, number];
  const bezier = (t: number, a: number, b: number) =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let low = 0;
    let high = 1;
    let t = x;
    for (let index = 0; index < 24; index += 1) {
      t = (low + high) / 2;
      if (bezier(t, x1, x2) < x) low = t;
      else high = t;
    }
    return bezier(t, y1, y2);
  };
}

function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(4, text.length - dot - 1);
}

/**
 * 统计数字滚动（规范 04 §3.12）：首次进入视口时从 0 滚动到目标值（`slow`，`easing-enter`），
 * 之后数值变化从当前值直接过渡。减少动效、无 IntersectionObserver 或 `enabled=false` 时直接显示目标值。
 */
export function useCountUp(
  target: number,
  {
    elementRef,
    enabled = true,
  }: { elementRef?: RefObject<Element | null>; enabled?: boolean } = {},
): number {
  const reducedMotion = usePrefersReducedMotion();
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const startedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const active =
    enabled &&
    !reducedMotion &&
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function';

  const set = (value: number) => {
    displayRef.current = value;
    setDisplay(value);
  };

  // 首次渲染在绘制前归零，等进入视口再滚动。
  useIsomorphicLayoutEffect(() => {
    if (!active || startedRef.current) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof IntersectionObserver !== 'function' || !elementRef?.current) {
      startedRef.current = true;
      return;
    }
    set(0);
  }, []);

  useEffect(() => {
    if (!active) {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      set(target);
      return;
    }
    const decimals = decimalsOf(target);
    const animate = () => {
      const from = displayRef.current;
      const duration = readDuration('--reachany-motion-duration-slow');
      if (duration <= 1 || from === target) {
        set(target);
        return;
      }
      const ease = readEasing('--reachany-motion-easing-enter');
      const startedAt = window.performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const value = from + (target - from) * ease(progress);
        set(progress >= 1 ? target : Number(value.toFixed(decimals)));
        frameRef.current = progress >= 1 ? null : window.requestAnimationFrame(step);
      };
      frameRef.current = window.requestAnimationFrame(step);
    };

    if (startedRef.current) {
      animate();
    } else {
      const node = elementRef?.current;
      if (!node || typeof IntersectionObserver !== 'function') {
        startedRef.current = true;
        set(target);
        return;
      }
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        startedRef.current = true;
        animate();
      });
      observer.observe(node);
      return () => {
        observer.disconnect();
        if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      };
    }
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [target, active]);

  return display;
}

export type StatTileCategory = 1 | 2 | 3 | 4;

export type StatTileProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 数字从 0 滚动到目标值（仅 `value` 为数字时生效）。 */
  animate?: boolean;
  /** 分类色 1–4（紫 / 绿 / 橙 / 紫罗兰），决定图标方块的浅底与图标色。默认 1。 */
  category?: StatTileCategory;
  /** 数字格式化（千分位、小数位等）；默认原样输出。 */
  formatValue?: (value: number) => string;
  /** lucide 图标元素。 */
  icon?: ReactNode;
  /** 数字下方的说明（12px）。 */
  label: ReactNode;
  /** 单位（正文字号），紧跟数字。 */
  unit?: ReactNode;
  value: ReactNode;
};

/** 统计块（规范 03 §3.17）：40px 分类色图标方块 + 数字/单位 + 说明。 */
export const StatTile = forwardRef<HTMLDivElement, StatTileProps>(function StatTile(
  { animate = false, category = 1, className, formatValue, icon, label, unit, value, ...props },
  ref,
) {
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const counted = useCountUp(numeric ? value : 0, {
    elementRef: valueRef,
    enabled: animate && numeric,
  });
  const format = (input: number) => (formatValue ? formatValue(input) : String(input));

  return (
    <div
      className={cn('rx-stat-tile', className)}
      data-category={String(category)}
      ref={ref}
      {...props}
    >
      {icon === undefined || icon === null ? null : (
        <span aria-hidden="true" className="rx-stat-tile-icon">
          {icon}
        </span>
      )}
      <div className="rx-stat-tile-text">
        <p className="rx-stat-tile-figure">
          {numeric && animate ? (
            <>
              <span aria-hidden="true" className="rx-stat-tile-value rx-numeric" ref={valueRef}>
                {format(counted)}
              </span>
              <span className="rx-visually-hidden">{format(value)}</span>
            </>
          ) : (
            <span className="rx-stat-tile-value rx-numeric" ref={valueRef}>
              {numeric ? format(value) : value}
            </span>
          )}
          {unit === undefined || unit === null ? null : (
            <span className="rx-stat-tile-unit">{unit}</span>
          )}
        </p>
        <p className="rx-stat-tile-label">{label}</p>
      </div>
    </div>
  );
});
