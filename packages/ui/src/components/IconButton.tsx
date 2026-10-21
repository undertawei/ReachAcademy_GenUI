'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';
import type { FloatingPlacement } from '../primitives/useFloating';
import type { ButtonVariant, ControlSize, ControlTouchTarget } from './Button';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** 图标（lucide 元素），16px，大小由尺寸决定。 */
  icon: ReactNode;
  /** 可读名称，同时作为 Tooltip 文案（规范 01 §9：纯图标按钮必须有 aria-label 与 Tooltip）。 */
  label: string;
  loading?: boolean;
  /** 不显示 Tooltip（例如触发器已有可见文字标签的场景）。默认显示。 */
  noTooltip?: boolean;
  size?: Exclude<ControlSize, 'xl'>;
  touchTarget?: ControlTouchTarget;
  tooltipPlacement?: FloatingPlacement;
  variant?: Extract<ButtonVariant, 'default' | 'ghost' | 'inverse' | 'ink' | 'outline' | 'primary'>;
};

/** 正方形图标按钮（28 / 32 / 36），规范 03 §3.1。 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    className,
    disabled = false,
    icon,
    label,
    loading = false,
    noTooltip = false,
    size,
    touchTarget,
    tooltipPlacement,
    type = 'button',
    variant = 'ghost',
    ...props
  },
  ref,
) {
  const button = (
    <button
      aria-busy={loading || undefined}
      aria-label={label}
      className={cn('rx-icon-button', 'rx-sized', className)}
      data-loading={loading ? 'true' : undefined}
      data-size={size}
      data-touch-target={touchTarget}
      data-variant={variant}
      disabled={disabled || loading}
      ref={ref}
      type={type}
      {...props}
    >
      <span aria-hidden="true" className="rx-icon-button-icon">
        {loading ? <Spinner size="sm" /> : icon}
      </span>
    </button>
  );
  if (noTooltip) return button;
  return (
    <Tooltip content={label} describeChild={false} placement={tooltipPlacement}>
      {button}
    </Tooltip>
  );
});
