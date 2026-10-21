'use client';

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import { cn } from '../cn';
import { Portal, useLayer } from '../primitives/layer';
import { mergeRefs } from '../primitives/refs';
import { useFloating, type FloatingPlacement } from '../primitives/useFloating';
import { usePresence } from '../primitives/usePresence';

/** 规范 03 §3.14、04 §3.7：悬停 400ms 出现、离开 100ms 消失；300ms 内移到相邻目标立即出现。 */
const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 100;
const WARM_WINDOW_MS = 300;

let lastClosedAt = 0;

type TriggerProps = {
  'aria-describedby'?: string;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
};

export interface TooltipProps {
  /** 单个可聚焦子元素（按钮、链接、带 tabIndex 的包装元素）。禁用按钮请外包一层可聚焦容器。 */
  children: ReactElement;
  className?: string;
  /** 只放纯文字。为空时不渲染提示。 */
  content: ReactNode;
  /**
   * 是否把提示关联为子元素的描述（aria-describedby）。子元素的可读名称已经等于提示文字
   * （例如 IconButton 的 aria-label）时传 false，避免读屏重复朗读。默认 true。
   */
  describeChild?: boolean;
  disabled?: boolean;
  placement?: FloatingPlacement;
}

export function Tooltip({
  children,
  className,
  content,
  describeChild = true,
  disabled = false,
  placement = 'top',
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const enabled = !disabled && content !== null && content !== undefined && content !== '';
  const isOpen = open && enabled;
  const presence = usePresence<HTMLDivElement>(isOpen);
  const floating = useFloating({
    anchor: triggerRef,
    floating: floatingRef,
    matchWidth: 'none',
    offset: 8,
    open: presence.mounted,
    placement,
  });
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen((current) => {
      if (current) lastClosedAt = Date.now();
      return false;
    });
  }, []);
  const layer = useLayer({
    active: isOpen,
    elements: [triggerRef, floatingRef],
    kind: 'tooltip',
    onDismiss: (reason) => {
      if (reason === 'escape') close();
    },
    outside: false,
  });

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!isValidElement<TriggerProps>(children)) return children;

  const childProps = children.props;
  const schedule = (next: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    if (delay <= 0) {
      if (next) setOpen(true);
      else close();
      return;
    }
    timer.current = window.setTimeout(() => (next ? setOpen(true) : close()), delay);
  };

  const trigger = cloneElement(children, {
    'aria-describedby':
      describeChild && isOpen
        ? cn(childProps['aria-describedby'], id) || undefined
        : childProps['aria-describedby'],
    onBlur: (event: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(event);
      schedule(false, 0);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(event);
      let keyboard = true;
      try {
        keyboard = event.currentTarget.matches(':focus-visible');
      } catch {
        keyboard = true;
      }
      if (keyboard) schedule(true, 0);
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerDown?.(event);
      schedule(false, 0);
    },
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerEnter?.(event);
      if (event.pointerType === 'touch') return;
      schedule(true, Date.now() - lastClosedAt < WARM_WINDOW_MS ? 0 : OPEN_DELAY_MS);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerLeave?.(event);
      schedule(false, CLOSE_DELAY_MS);
    },
    ref: mergeRefs(childProps.ref, (node: HTMLElement | null) => {
      triggerRef.current = node;
    }),
  });

  return (
    <>
      {trigger}
      {presence.mounted ? (
        <Portal>
          <layer.Provider>
            <div
              className={cn('rx-tooltip', className)}
              data-side={floating.side}
              data-state={presence.state}
              id={id}
              ref={(node) => {
                floatingRef.current = node;
                presence.ref(node);
              }}
              role="tooltip"
              style={{ ...floating.style, zIndex: layer.zIndex }}
            >
              {content}
              <span aria-hidden="true" className="rx-tooltip-arrow" />
            </div>
          </layer.Provider>
        </Portal>
      ) : null}
    </>
  );
}
