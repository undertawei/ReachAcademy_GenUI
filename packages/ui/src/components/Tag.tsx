import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';

/*
 * 标签与状态（规范 03 §3.18）。全部只读、不可点击；可点击的「标签」用 SegmentedControl、Tabs 或筛选 Select。
 * 状态文案由调用方从枚举 + i18n 取，不直接显示后端原始值。
 */

type SpanProps = HTMLAttributes<HTMLSpanElement>;

export type MetaTagProps = SpanProps & {
  /** 可选前置图标（12px）。 */
  icon?: ReactNode;
};

/** 元数据标签：`amber-soft` 底 + `accent-text` 字，圆角 4，2×8，12px（学段、学科、平台公开课）。 */
export const MetaTag = forwardRef<HTMLSpanElement, MetaTagProps>(function MetaTag(
  { children, className, icon, ...props },
  ref,
) {
  return (
    <span className={cn('rx-tag', 'rx-meta-tag', className)} ref={ref} {...props}>
      {icon ? (
        <span aria-hidden="true" className="rx-tag-icon">
          {icon}
        </span>
      ) : null}
      <span className="rx-tag-label">{children}</span>
    </span>
  );
});

export type TagTone = 'amber' | 'green' | 'neutral' | 'orange' | 'primary' | 'purple';

export type TagProps = MetaTagProps & {
  /** 分类色：浅底 + AA 深字。默认 `neutral`。 */
  tone?: TagTone;
};

/** 分类标签（测评、SRL…）：规格同 MetaTag，颜色按 `tone`。 */
export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { children, className, icon, tone = 'neutral', ...props },
  ref,
) {
  return (
    <span className={cn('rx-tag', className)} data-tone={tone} ref={ref} {...props}>
      {icon ? (
        <span aria-hidden="true" className="rx-tag-icon">
          {icon}
        </span>
      ) : null}
      <span className="rx-tag-label">{children}</span>
    </span>
  );
});

export type StatusTone =
  | 'danger'
  | 'info'
  | 'neutral'
  | 'pending'
  | 'published'
  | 'success'
  | 'warning';

export type StatusPillProps = MetaTagProps & {
  /** 1px 描边（同色 30%）。`pending` 始终带 `primary` 描边。 */
  bordered?: boolean;
  /** `sm`：2×8 / 12px（默认）；`md`：6×12 / 14px。 */
  size?: 'md' | 'sm';
  /** 语义状态色（规范 01 §2.4）。默认 `neutral`。 */
  tone?: StatusTone;
};

/** 状态胶囊（等待教师确认、难度：进阶、知识检测）。 */
export const StatusPill = forwardRef<HTMLSpanElement, StatusPillProps>(function StatusPill(
  { bordered, children, className, icon, size, tone = 'neutral', ...props },
  ref,
) {
  return (
    <span
      className={cn('rx-status-pill', className)}
      data-bordered={bordered ? 'true' : undefined}
      data-size={size}
      data-tone={tone}
      ref={ref}
      {...props}
    >
      {icon ? (
        <span aria-hidden="true" className="rx-tag-icon">
          {icon}
        </span>
      ) : null}
      <span className="rx-tag-label">{children}</span>
    </span>
  );
});

export type BadgeTone = 'primary' | 'published' | 'success' | 'warning';

export type BadgeProps = SpanProps & {
  /** 实心底色，白字。默认 `primary`。 */
  tone?: BadgeTone;
};

/** 实心徽标（未保存）：圆角 4、高 20、12px 白字。 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone = 'primary', ...props },
  ref,
) {
  return <span className={cn('rx-badge', className)} data-tone={tone} ref={ref} {...props} />;
});

export type RibbonProps = SpanProps & {
  /** 默认 `published`。 */
  tone?: BadgeTone;
};

/**
 * 卡片右上角角标（已发布）：放在 Card 内，贴右上角；圆角「右上随卡片、左下 8」。
 */
export const Ribbon = forwardRef<HTMLSpanElement, RibbonProps>(function Ribbon(
  { className, tone = 'published', ...props },
  ref,
) {
  return <span className={cn('rx-ribbon', className)} data-tone={tone} ref={ref} {...props} />;
});

export type DotProps = Omit<SpanProps, 'children'> & {
  /** 读屏文字（如「有未读通知」）；不传时视为装饰，对读屏隐藏。 */
  label?: string;
};

/** 6px `primary` 圆点（未读）。 */
export const Dot = forwardRef<HTMLSpanElement, DotProps>(function Dot(
  { className, label, ...props },
  ref,
) {
  return (
    <span
      aria-hidden={label === undefined ? 'true' : undefined}
      className={cn('rx-dot', className)}
      ref={ref}
      {...props}
    >
      {label === undefined ? null : <span className="rx-visually-hidden">{label}</span>}
    </span>
  );
});

export type CountBadgeProps = Omit<SpanProps, 'children'> & {
  count: number;
  /** 读屏文字模板，例如 `(n) => \`${n} 条未读\``；不传时读出数字本身。 */
  formatLabel?: (count: number) => string;
  /** 超过后显示 `max+`，默认 99。 */
  max?: number;
  /** count 为 0 时是否仍显示，默认隐藏。 */
  showZero?: boolean;
};

/** 数字徽标：最小 16px 胶囊、11px 数字、`primary`（学习笔记(10)、未读数）。 */
export const CountBadge = forwardRef<HTMLSpanElement, CountBadgeProps>(function CountBadge(
  { className, count, formatLabel, max = 99, showZero = false, ...props },
  ref,
) {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safe === 0 && !showZero) return null;
  const text = safe > max ? `${max}+` : String(safe);
  const label = formatLabel?.(safe);
  return (
    <span className={cn('rx-count-badge', 'rx-numeric', className)} ref={ref} {...props}>
      <span aria-hidden={label === undefined ? undefined : 'true'}>{text}</span>
      {label === undefined ? null : <span className="rx-visually-hidden">{label}</span>}
    </span>
  );
});
