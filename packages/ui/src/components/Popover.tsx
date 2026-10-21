'use client';

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import { cn } from '../cn';
import { getFocusableElements } from '../primitives/focus';
import { Portal, useLayer } from '../primitives/layer';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import { useFloating, type FloatingPlacement } from '../primitives/useFloating';
import { usePresence } from '../primitives/usePresence';

type TriggerProps = {
  'aria-controls'?: string;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: 'dialog';
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
};

export interface PopoverProps {
  /** 浮层内容，可以包含交互元素。 */
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  /** 浮层的可读名称（role=dialog）。 */
  label?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  placement?: FloatingPlacement;
  /** 单个可点击的触发元素（按钮）。 */
  trigger: ReactElement;
  /** 宽度策略：默认不约束（内容决定），`min` 至少与触发器等宽。 */
  matchWidth?: 'exact' | 'min' | 'none';
}

/**
 * 点击打开的浮层（规范 03 §3.14）：点外部或 Esc 关闭，焦点回到触发器。
 * 用于日程详情卡、+N 胶囊列表、筛选收纳等带交互内容的场景；纯文字提示用 Tooltip。
 */
export function Popover({
  children,
  className,
  defaultOpen = false,
  label,
  matchWidth = 'none',
  onOpenChange,
  open: openProp,
  placement = 'bottom-start',
  trigger,
}: PopoverProps) {
  const [open, setOpen] = useControllableState({
    defaultValue: defaultOpen,
    onChange: onOpenChange,
    value: openProp,
  });
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>(open);
  const floating = useFloating({
    anchor: triggerRef,
    floating: panelRef,
    matchWidth,
    open: presence.mounted,
    placement,
  });
  const layer = useLayer({
    active: open,
    elements: [triggerRef, panelRef],
    kind: 'dropdown',
    onDismiss: (reason) => {
      setOpen(false);
      if (reason === 'escape') triggerRef.current?.focus();
    },
  });

  const positioned = floating.style.visibility !== 'hidden';
  useEffect(() => {
    if (!open || !positioned) return;
    const panel = panelRef.current;
    if (!panel) return;
    const [first] = getFocusableElements(panel);
    if (first) first.focus({ preventScroll: true });
    else panel.focus({ preventScroll: true });
    return () => {
      if (panel.contains(document.activeElement))
        triggerRef.current?.focus({ preventScroll: true });
    };
  }, [open, positioned]);

  if (!isValidElement<TriggerProps>(trigger)) return null;
  const triggerProps = trigger.props;

  return (
    <>
      {cloneElement(trigger, {
        'aria-controls': open ? id : undefined,
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        onClick: (event: MouseEvent<HTMLElement>) => {
          triggerProps.onClick?.(event);
          if (!event.defaultPrevented) setOpen((current) => !current);
        },
        ref: mergeRefs(triggerProps.ref, (node: HTMLElement | null) => {
          triggerRef.current = node;
        }),
      })}
      {presence.mounted ? (
        <Portal>
          <layer.Provider>
            <div
              aria-label={label}
              className={cn('rx-floating-panel', 'rx-popover', className)}
              data-side={floating.side}
              data-state={presence.state}
              id={id}
              ref={(node) => {
                panelRef.current = node;
                presence.ref(node);
              }}
              role="dialog"
              style={{ ...floating.style, zIndex: layer.zIndex }}
              tabIndex={-1}
            >
              {children}
            </div>
          </layer.Provider>
        </Portal>
      ) : null}
    </>
  );
}
