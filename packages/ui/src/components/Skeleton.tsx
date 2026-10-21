'use client';

import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

import { cn } from '../cn';

export type SkeletonVariant = 'circle' | 'rectangle' | 'text';

export type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  height?: CSSProperties['height'];
  /** 读屏文字（「加载中」）；传入后骨架成为 `role="status"` + `aria-busy`，否则对读屏隐藏。 */
  label?: string;
  lines?: number;
  variant?: SkeletonVariant;
  width?: CSSProperties['width'];
};

/**
 * 骨架占位（规范 03 §3.27、04 §3.3）：形状与最终内容一致，`surface-muted` 底 + 1.2s 线性微光；
 * 减少动效时不播放微光。显示时机用 `useDelayedVisibility` 防闪烁。
 */
export function Skeleton({
  className,
  height,
  label,
  lines = 1,
  style,
  variant = 'text',
  width,
  ...props
}: SkeletonProps) {
  const lineCount = Number.isFinite(lines) ? Math.min(20, Math.max(1, Math.floor(lines))) : 1;
  return (
    <div
      aria-busy={label === undefined ? undefined : true}
      aria-hidden={label === undefined ? 'true' : undefined}
      className={cn('rx-skeleton', `rx-skeleton-${variant}`, className)}
      role={label === undefined ? undefined : 'status'}
      style={{ ...style, height, width }}
      {...props}
    >
      {Array.from({ length: lineCount }, (_, index) => (
        <span className="rx-skeleton-line" key={index} />
      ))}
      {label === undefined ? null : <span className="rx-visually-hidden">{label}</span>}
    </div>
  );
}

function StatusShell({
  children,
  className,
  label,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return (
    <div
      aria-busy={label === undefined ? undefined : true}
      aria-hidden={label === undefined ? 'true' : undefined}
      className={className}
      role={label === undefined ? undefined : 'status'}
      {...props}
    >
      {children}
      {label === undefined ? null : <span className="rx-visually-hidden">{label}</span>}
    </div>
  );
}

export type SkeletonListProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 每行前显示头像圆。 */
  avatar?: boolean;
  label?: string;
  /** 行数，限制在 3–6（规范 03 §3.27：不要满屏铺）。默认 4。 */
  rows?: number;
};

/** 列表骨架：3–6 行，每行标题条 + 说明条（可带头像圆）。 */
export function SkeletonList({
  avatar = false,
  className,
  label,
  rows = 4,
  ...props
}: SkeletonListProps) {
  const count = Number.isFinite(rows) ? Math.min(6, Math.max(3, Math.floor(rows))) : 4;
  return (
    <StatusShell className={cn('rx-skeleton-list', className)} label={label} {...props}>
      {Array.from({ length: count }, (_, index) => (
        <div className="rx-skeleton-list-row" key={index}>
          {avatar ? <Skeleton className="rx-skeleton-list-avatar" variant="circle" /> : null}
          <Skeleton className="rx-skeleton-list-text" lines={2} />
        </div>
      ))}
    </StatusShell>
  );
}

export type SkeletonCardProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  label?: string;
};

/** 卡片骨架：16:9 封面 + 两行文字。 */
export function SkeletonCard({ className, label, ...props }: SkeletonCardProps) {
  return (
    <StatusShell className={cn('rx-skeleton-card', className)} label={label} {...props}>
      <Skeleton className="rx-skeleton-card-cover" variant="rectangle" />
      <Skeleton className="rx-skeleton-card-text" lines={2} />
    </StatusShell>
  );
}

export interface DelayedVisibilityOptions {
  /** 加载超过多久才显示（ms）。默认 200。 */
  delay?: number;
  /** 一旦显示至少保持多久（ms）。默认 300。 */
  minDuration?: number;
}

/**
 * 骨架/加载指示的防闪烁时序（规范 04 §3.3、05 §2）：`loading` 持续超过 `delay` 才返回 true，
 * 一旦返回 true 至少保持 `minDuration`，即使数据已经回来。
 *
 * ```tsx
 * const showSkeleton = useDelayedVisibility(isLoading);
 * if (showSkeleton) return <SkeletonList label={t('common.loading')} />;
 * if (isLoading) return null; // 200ms 内不闪骨架
 * ```
 */
export function useDelayedVisibility(
  loading: boolean,
  { delay = 200, minDuration = 300 }: DelayedVisibilityOptions = {},
): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (loading) {
      if (visible) return;
      const timer = window.setTimeout(
        () => {
          shownAt.current = Date.now();
          setVisible(true);
        },
        Math.max(0, delay),
      );
      return () => window.clearTimeout(timer);
    }
    if (!visible) return;
    const elapsed = shownAt.current === null ? minDuration : Date.now() - shownAt.current;
    const remaining = Math.max(0, minDuration - elapsed);
    const hide = () => {
      shownAt.current = null;
      setVisible(false);
    };
    if (remaining === 0) {
      hide();
      return;
    }
    const timer = window.setTimeout(hide, remaining);
    return () => window.clearTimeout(timer);
  }, [delay, loading, minDuration, visible]);

  return visible;
}
