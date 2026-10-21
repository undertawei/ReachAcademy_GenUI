import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../cn';

export type PageHeaderProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  /** 右侧：筛选、搜索、主操作（高 36，间距 12–16，主操作放最右）。 */
  actions?: ReactNode;
  /** 副标题：body-sm、text-secondary。 */
  description?: ReactNode;
  /**
   * 标题尺寸：`xl`（默认）为总览页衬线大标题 title-xl；`lg` 为详情页 title-lg；
   * `md` 为嵌在面板/管理页里的 title-md。
   */
  size?: 'lg' | 'md' | 'xl';
  title: ReactNode;
};

/** 页头（规范 02 §3 T1、§8）：标题左对齐，操作右对齐；在 PageLayout 里固定不随内容滚动。 */
export function PageHeader({
  actions,
  className,
  description,
  size = 'xl',
  title,
  ...props
}: PageHeaderProps) {
  return (
    <header className={cn('rx-page-header', className)} data-size={size} {...props}>
      <div className="rx-page-header-text">
        <h1 className="rx-page-header-title">{title}</h1>
        {description === undefined ? null : (
          <p className="rx-page-header-description">{description}</p>
        )}
      </div>
      {actions ? <div className="rx-page-header-actions">{actions}</div> : null}
    </header>
  );
}
