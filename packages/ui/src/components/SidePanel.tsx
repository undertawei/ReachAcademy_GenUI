'use client';

import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import { IconButton } from './IconButton';

export interface SidePanelProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** 内容区（面板内唯一的滚动容器）。 */
  children?: ReactNode;
  collapsed?: boolean;
  /** 收起按钮的可读名称与 Tooltip。 */
  collapseLabel: string;
  defaultCollapsed?: boolean;
  /** 展开按钮的可读名称与 Tooltip。 */
  expandLabel: string;
  /** 固定在底部的区域（输入框、主操作）。 */
  footer?: ReactNode;
  /** 固定在顶部的区域（通常是 Tabs）；右侧自动留出收起按钮的位置。 */
  header?: ReactNode;
  onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * 记住收起状态的 localStorage 键（规范 03 §3.19：按页面类型记忆，调用方按页面类型取键）。
   * 挂载时读取已存的值（受控时通过 onCollapsedChange 通知），用户点击切换时写入。
   */
  persistKey?: string;
  /** Header minimum height only: md (default) 56px, sm 44px. Panel widths stay unchanged. */
  size?: 'sm' | 'md';
}

function readStored(key: string): boolean | undefined {
  try {
    const value = window.localStorage.getItem(key);
    if (value === 'true') return true;
    if (value === 'false') return false;
  } catch {
    // 隐私模式等场景下 localStorage 不可用，按未记忆处理。
  }
  return undefined;
}

function writeStored(key: string, collapsed: boolean) {
  try {
    window.localStorage.setItem(key, String(collapsed));
  } catch {
    // 忽略写入失败。
  }
}

/**
 * 嵌入式可收起侧面板（规范 02 T4、03 §3.19、04 §3.5）：宽 `--reachany-side-panel-width`，
 * 收起为 `--reachany-side-panel-collapsed-width` 竖条，只保留展开按钮。
 * 收起时内容先淡出再收窄；展开时宽度到位后内容再淡入。
 */
export const SidePanel = forwardRef<HTMLElement, SidePanelProps>(function SidePanel(
  {
    children,
    className,
    collapseLabel,
    collapsed: collapsedProp,
    defaultCollapsed = false,
    expandLabel,
    footer,
    header,
    onCollapsedChange,
    persistKey,
    size = 'md',
    ...props
  },
  ref,
) {
  const [collapsed, setCollapsed] = useControllableState({
    defaultValue: defaultCollapsed,
    onChange: onCollapsedChange,
    value: collapsedProp,
  });
  // 挂载后才开启宽度过渡，避免恢复记忆状态（含 SSR 水合后）时播放一次收起动画。
  const [ready, setReady] = useState(false);
  const bodyId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    if (!persistKey) return;
    const stored = readStored(persistKey);
    if (stored !== undefined) setCollapsed(stored);
    // 只在挂载或键变化时恢复；setCollapsed 在受控切换时才会变化，不应触发重新读取。
  }, [persistKey]);

  useEffect(() => {
    setReady(true);
  }, []);

  // 收起时焦点若在即将隐藏的内容里，移到展开按钮上，避免焦点丢到 body。
  useEffect(() => {
    if (!collapsed) return;
    const panel = panelRef.current;
    const active = document.activeElement;
    if (
      panel &&
      active instanceof HTMLElement &&
      panel.contains(active) &&
      active !== toggleRef.current
    ) {
      toggleRef.current?.focus({ preventScroll: true });
    }
  }, [collapsed]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (persistKey) writeStored(persistKey, next);
  };

  return (
    <aside
      {...props}
      className={cn('rx-side-panel', className)}
      data-ready={ready ? '' : undefined}
      data-size={size}
      data-state={collapsed ? 'closed' : 'open'}
      ref={mergeRefs(ref, (node: HTMLElement | null) => {
        panelRef.current = node;
      })}
    >
      <div className="rx-side-panel-inner">
        <div className="rx-side-panel-header">
          <div className="rx-side-panel-header-content rx-side-panel-fade" inert={collapsed}>
            {header}
          </div>
          <IconButton
            aria-controls={bodyId}
            aria-expanded={!collapsed}
            className="rx-side-panel-toggle"
            icon={
              collapsed ? (
                <PanelRightOpen strokeWidth={1.5} />
              ) : (
                <PanelRightClose strokeWidth={1.5} />
              )
            }
            label={collapsed ? expandLabel : collapseLabel}
            onClick={toggle}
            ref={toggleRef}
            tooltipPlacement="left"
            variant="ghost"
          />
        </div>
        <div
          className="rx-side-panel-body rx-scroll-y rx-side-panel-fade"
          id={bodyId}
          inert={collapsed}
        >
          {children}
        </div>
        {footer === undefined || footer === null || footer === false ? null : (
          <div className="rx-side-panel-footer rx-side-panel-fade" inert={collapsed}>
            {footer}
          </div>
        )}
      </div>
    </aside>
  );
});
