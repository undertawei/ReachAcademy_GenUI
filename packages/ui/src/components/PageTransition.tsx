import type { HTMLAttributes } from 'react';

import { cn } from '../cn';

export type PageTransitionProps = HTMLAttributes<HTMLDivElement> & {
  /**
   * 固定视口模板（规范 02 §3 T2–T5）下让过渡容器占满父级高度并作为 flex 列，
   * 这样页面内部的滚动容器仍能拿到确定的高度。
   */
  fill?: boolean;
};

/**
 * 页面内容入场动效（规范 04 §3.2）。在各 app 角色路由段的 `template.tsx` 中包裹 children；
 * Header、二级侧栏与应用壳不参与过渡。
 */
export function PageTransition({ className, fill = false, ...props }: PageTransitionProps) {
  return (
    <div
      className={cn('rx-page-transition', className)}
      data-fill={fill ? 'true' : undefined}
      {...props}
    />
  );
}
