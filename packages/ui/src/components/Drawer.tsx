'use client';

import { forwardRef } from 'react';

import { OverlayShell, type OverlayBaseProps } from './Dialog';

/** 抽屉宽度（规范 03 §3.19）：sm 400、md 560（默认）、lg 720。 */
export type DrawerSize = 'lg' | 'md' | 'sm';

export interface DrawerProps extends OverlayBaseProps {
  /** `right`（默认）从右侧滑入；`bottom` 用于平板学生端，最大高度 85dvh，顶部带拖动条装饰。 */
  placement?: 'bottom' | 'right';
  /** 只对右侧抽屉生效。 */
  size?: DrawerSize;
}

/**
 * 覆盖式抽屉（规范 03 §3.19、04 §3.5）：审批、详情、学习进度等不离开当前页的辅助任务。
 * 头尾结构、关闭方式、焦点与未保存确认与 Dialog 相同（见 DialogProps）；层级 `z-drawer`。
 */
export const Drawer = forwardRef<HTMLDivElement, DrawerProps>(function Drawer(
  { placement = 'right', ...props },
  ref,
) {
  return (
    <OverlayShell {...props} layerKind="drawer" placement={placement} ref={ref} variant="drawer" />
  );
});
