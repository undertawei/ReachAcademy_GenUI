'use client';

import { CircleAlert, Info, Lightbulb, TriangleAlert, X } from 'lucide-react';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';
import { IconButton } from './IconButton';

export type InlineNoticeTone = 'error' | 'info' | 'tip' | 'warning';

const DEFAULT_ICONS: Record<InlineNoticeTone, typeof Info> = {
  error: CircleAlert,
  info: Info,
  tip: Lightbulb,
  warning: TriangleAlert,
};

export type InlineNoticeProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /** 右侧操作（链接或 `link`/`ghost` 小按钮）。 */
  action?: ReactNode;
  /** 整行横幅：圆角 `lg`。 */
  banner?: boolean;
  /** 关闭按钮的可读名称；与 `onDismiss` 一起传入时显示 ×。 */
  dismissLabel?: string;
  /** 自定义图标；传 `null` 不显示。默认按 `tone` 取。 */
  icon?: ReactNode;
  onDismiss?: () => void;
  title?: ReactNode;
  /** `info`（紫浅底，默认）/ `warning` / `error` / `tip`（白底 + 灯泡 + primary 字）。 */
  tone?: InlineNoticeTone;
};

/**
 * 页面或区块内的持久提示（规范 03 §3.21）。默认 `role="status"`，`error` 为 `role="alert"`。
 * 需要用户处理才能继续的错误用它，而不是 Toast。
 */
export const InlineNotice = forwardRef<HTMLDivElement, InlineNoticeProps>(function InlineNotice(
  {
    action,
    banner = false,
    children,
    className,
    dismissLabel,
    icon,
    onDismiss,
    role,
    title,
    tone = 'info',
    ...props
  },
  ref,
) {
  const DefaultIcon = DEFAULT_ICONS[tone] ?? Info;
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <div
      className={cn('rx-inline-notice', className)}
      data-banner={banner ? 'true' : undefined}
      data-tone={tone}
      ref={ref}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      {...props}
    >
      {icon === null ? null : (
        <span aria-hidden="true" className="rx-inline-notice-icon">
          {icon ?? <DefaultIcon strokeWidth={1.5} />}
        </span>
      )}
      <div className="rx-inline-notice-content">
        {title === undefined || title === null ? null : (
          <p className="rx-inline-notice-title">{title}</p>
        )}
        {hasBody ? <div className="rx-inline-notice-body">{children}</div> : null}
      </div>
      {action === undefined || action === null ? null : (
        <div className="rx-inline-notice-action">{action}</div>
      )}
      {onDismiss && dismissLabel ? (
        <IconButton
          className="rx-inline-notice-dismiss"
          icon={<X strokeWidth={1.5} />}
          label={dismissLabel}
          onClick={onDismiss}
          size="sm"
          variant="ghost"
        />
      ) : null}
    </div>
  );
});

export type ContextChipProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  children: ReactNode;
  /** 可选前置图标（14px）。 */
  icon?: ReactNode;
  onRemove?: () => void;
  /** × 按钮的可读名称；与 `onRemove` 一起传入时显示 ×。 */
  removeLabel?: string;
};

/**
 * AI 面板上下文胶囊（「当前页：…」）：`primary-soft` 底 + `primary` 描边与文字，单行省略，右侧 ×。
 */
export const ContextChip = forwardRef<HTMLSpanElement, ContextChipProps>(function ContextChip(
  { children, className, icon, onRemove, removeLabel, title, ...props },
  ref,
) {
  return (
    <span
      className={cn('rx-context-chip', className)}
      ref={ref}
      title={title ?? (typeof children === 'string' ? children : undefined)}
      {...props}
    >
      {icon ? (
        <span aria-hidden="true" className="rx-context-chip-icon">
          {icon}
        </span>
      ) : null}
      <span className="rx-context-chip-label">{children}</span>
      {onRemove && removeLabel ? (
        <button
          aria-label={removeLabel}
          className="rx-context-chip-remove"
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" strokeWidth={1.5} />
        </button>
      ) : null}
    </span>
  );
});
