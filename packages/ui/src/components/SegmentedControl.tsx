'use client';

import {
  forwardRef,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';

export interface SegmentedOption {
  /** `role="tablist"` 时对应面板的 id（写到 `aria-controls`）。 */
  controls?: string;
  disabled?: boolean;
  /** 16px 图标（lucide 元素）。 */
  icon?: ReactNode;
  label: ReactNode;
  value: string;
}

export type SegmentedControlSize = 'lg' | 'md' | 'sm';

export type SegmentedControlProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'defaultValue' | 'onChange' | 'role'
> & {
  defaultValue?: string | null;
  disabled?: boolean;
  onChange?: (value: string) => void;
  /** 2–5 个等宽选项。 */
  options: readonly SegmentedOption[];
  /** 语义：选择值用 `radiogroup`（默认），切换视图用 `tablist`。 */
  role?: 'radiogroup' | 'tablist';
  /** sm 高 24 胶囊 / md 高 40 圆角 8（默认）/ lg 高 56 胶囊；`tone="neutral"` 固定高 36。 */
  size?: SegmentedControlSize;
  /** `neutral`：暖白弹窗内的来源切换，选中块 `border-warm` 底 + `text` 500，不使用 `primary`。 */
  tone?: 'neutral' | 'primary';
  /** 受控值；`null` 表示受控且未选中。 */
  value?: string | null;
};

const MOVE_KEYS: Record<string, number> = {
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
};

/**
 * 分段控件（规范 03 §3.10，动效 04 §3.8）：等宽选项 + 滑动选中块。
 * 键盘：方向键在可用选项间循环移动并选中，Home/End 到首/末项；Tab 只停在选中项。
 */
export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl(
    {
      className,
      defaultValue = null,
      disabled = false,
      onChange,
      onKeyDown,
      options,
      role = 'radiogroup',
      size,
      style,
      tone = 'primary',
      value: valueProp,
      ...props
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [value, setValue] = useControllableState<string | null>({
      defaultValue,
      onChange: (next) => {
        if (next !== null) onChange?.(next);
      },
      value: valueProp,
    });
    const selectedIndex = options.findIndex((option) => option.value === value);
    const enabledIndexes = options
      .map((option, index) => (disabled || option.disabled ? -1 : index))
      .filter((index) => index >= 0);
    const tabStop =
      selectedIndex >= 0 && enabledIndexes.includes(selectedIndex)
        ? selectedIndex
        : (enabledIndexes[0] ?? -1);
    const isTabs = role === 'tablist';

    const focusAndSelect = (index: number) => {
      const option = options[index];
      if (!option) return;
      rootRef.current?.querySelectorAll<HTMLButtonElement>('.rx-segmented-item')[index]?.focus();
      setValue(option.value);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || enabledIndexes.length === 0) return;
      const target = event.target as HTMLElement;
      const current = Number(target.getAttribute('data-index'));
      if (!target.classList.contains('rx-segmented-item') || Number.isNaN(current)) return;
      let next: number | undefined;
      if (event.key === 'Home') next = enabledIndexes[0];
      else if (event.key === 'End') next = enabledIndexes[enabledIndexes.length - 1];
      else if (MOVE_KEYS[event.key] !== undefined) {
        const position = enabledIndexes.indexOf(current);
        const delta = MOVE_KEYS[event.key];
        const from = position < 0 ? (delta > 0 ? -1 : 0) : position;
        next = enabledIndexes[(from + delta + enabledIndexes.length) % enabledIndexes.length];
      }
      if (next === undefined) return;
      event.preventDefault();
      focusAndSelect(next);
    };

    const indicatorStyle = {
      ...style,
      '--rx-segment-count': Math.max(options.length, 1),
      '--rx-segment-index': Math.max(selectedIndex, 0),
    } as CSSProperties;

    return (
      <div
        aria-disabled={disabled || undefined}
        aria-orientation={isTabs ? 'horizontal' : undefined}
        className={cn('rx-segmented', className)}
        data-size={size}
        data-tone={tone}
        onKeyDown={handleKeyDown}
        ref={mergeRefs(ref, rootRef)}
        role={role}
        style={indicatorStyle}
        {...props}
      >
        <span
          aria-hidden="true"
          className="rx-segmented-indicator"
          data-state={selectedIndex >= 0 ? 'visible' : 'hidden'}
        />
        {options.map((option, index) => {
          const selected = index === selectedIndex;
          const itemDisabled = disabled || option.disabled;
          return (
            <button
              aria-checked={isTabs ? undefined : selected}
              aria-controls={isTabs ? option.controls : undefined}
              aria-selected={isTabs ? selected : undefined}
              className="rx-segmented-item"
              data-index={index}
              data-state={selected ? 'selected' : 'unselected'}
              disabled={itemDisabled}
              key={option.value}
              onClick={() => setValue(option.value)}
              role={isTabs ? 'tab' : 'radio'}
              tabIndex={index === tabStop ? 0 : -1}
              type="button"
            >
              {option.icon === undefined || option.icon === null ? null : (
                <span aria-hidden="true" className="rx-segmented-icon">
                  {option.icon}
                </span>
              )}
              <span className="rx-segmented-label">{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  },
);
