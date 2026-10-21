'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';
import { Tooltip } from './Tooltip';

export type RoleHeaderActionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** 20px 线性图标（lucide 元素）。 */
  icon: ReactNode;
  /** 可读名称，同时作为 Tooltip。 */
  label: string;
  /** 未读等提示：右上角 6px 朱砂红点（规范 02 §2、05 §9）。 */
  dot?: boolean;
};

/**
 * RoleHeader 右侧的图标操作（通知铃铛等）：深色底上的 34×34 透明按钮。
 * 通过 RoleHeader 的 `headerActions` 插槽传入。
 */
export const RoleHeaderAction = forwardRef<HTMLButtonElement, RoleHeaderActionProps>(
  function RoleHeaderAction(
    { className, dot = false, icon, label, type = 'button', ...props },
    ref,
  ) {
    return (
      <Tooltip content={label} describeChild={false} placement="bottom">
        <button
          aria-label={label}
          className={cn('rx-role-header-action', className)}
          ref={ref}
          type={type}
          {...props}
        >
          <span aria-hidden="true" className="rx-role-header-action-icon">
            {icon}
          </span>
          {dot ? <span aria-hidden="true" className="rx-role-header-dot" /> : null}
        </button>
      </Tooltip>
    );
  },
);
