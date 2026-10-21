'use client';

import { ChevronRight } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { useControllableState } from '../primitives/useControllableState';

export type CollapseProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /** 标题行右侧的附加内容（计数、操作按钮）；不在展开按钮内部。 */
  actions?: ReactNode;
  defaultOpen?: boolean;
  disabled?: boolean;
  /** 标题所在的标题层级（APG Accordion：按钮包在 heading 里）。默认 3。 */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  title: ReactNode;
};

/**
 * 折叠面板（规范 03 §3.22、04 §3.9）：标题行左侧 ▸（展开旋转 90°，`fast`），标题 16/600；
 * 内容区 `surface-warm` 底、圆角 12，`grid-template-rows: 0fr → 1fr` + 淡入（`moderate` `standard`）。
 * 收起时内容区 `inert`，不可聚焦也不被读屏读到。
 */
export const Collapse = forwardRef<HTMLDivElement, CollapseProps>(function Collapse(
  {
    actions,
    children,
    className,
    defaultOpen = false,
    disabled = false,
    headingLevel = 3,
    onOpenChange,
    open: openProp,
    title,
    ...props
  },
  ref,
) {
  const [open, setOpen] = useControllableState({
    defaultValue: defaultOpen,
    onChange: onOpenChange,
    value: openProp,
  });
  const id = useId();
  const triggerId = `${id}-trigger`;
  const panelId = `${id}-panel`;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const Heading = `h${headingLevel}` as const;

  // React 18/19 对 `inert` 属性的写法不同，直接操作 DOM 保证两边一致。
  useLayoutEffect(() => {
    panelRef.current?.toggleAttribute('inert', !open);
  }, [open]);

  const toggle = useCallback(() => {
    if (!disabled) setOpen((current) => !current);
  }, [disabled, setOpen]);

  const state = open ? 'open' : 'closed';
  return (
    <div className={cn('rx-collapse', className)} data-state={state} ref={ref} {...props}>
      <div className="rx-collapse-header">
        <Heading className="rx-collapse-heading">
          <button
            aria-controls={panelId}
            aria-expanded={open}
            className="rx-collapse-trigger"
            data-state={state}
            disabled={disabled}
            id={triggerId}
            onClick={toggle}
            type="button"
          >
            <ChevronRight aria-hidden="true" className="rx-collapse-chevron" strokeWidth={1.5} />
            <span className="rx-collapse-title">{title}</span>
          </button>
        </Heading>
        {actions === undefined || actions === null ? null : (
          <div className="rx-collapse-actions">{actions}</div>
        )}
      </div>
      <div
        aria-labelledby={triggerId}
        className="rx-collapse-panel"
        data-state={state}
        id={panelId}
        ref={panelRef}
        role="region"
      >
        <div className="rx-collapse-panel-inner">
          <div className="rx-collapse-content">{children}</div>
        </div>
      </div>
    </div>
  );
});
