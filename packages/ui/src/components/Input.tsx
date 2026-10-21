'use client';

import { X } from 'lucide-react';
import {
  forwardRef,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import type { ControlSize, ControlTouchTarget } from './Button';
import { useFormFieldControl } from './FormField';
import { IconButton } from './IconButton';

/** 输入框外观（规范 03 §3.2）：`outlined` 用于弹窗、暖白区块与学生端；`filled` 用于白色卡片内的密集表单。 */
export type InputVariant = 'filled' | 'outlined';

/**
 * 以「用户输入」的方式改写原生输入框的值：走原型上的 value setter 再派发 input 事件，
 * 这样 React 的 onChange、受控/非受控、表单库监听都能收到，与用户手动删除一致。
 */
export function setNativeInputValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

export type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'defaultValue' | 'prefix' | 'size' | 'value'
> & {
  /** 有值且悬停/聚焦时显示清除按钮；需同时提供 `clearLabel`。 */
  clearable?: boolean;
  /** 清除按钮的可读名称（同时作为 Tooltip）。 */
  clearLabel?: string;
  defaultValue?: string;
  invalid?: boolean;
  /** 清除后回调（onChange/onValueChange 已先以空值触发）。 */
  onClear?: () => void;
  /** 值变化（输入、清除）时以字符串回调；原生 `onChange(event)` 仍可用。 */
  onValueChange?: (value: string) => void;
  /** 前缀（16px 图标或短文字），距左边 12。 */
  prefix?: ReactNode;
  size?: ControlSize;
  touchTarget?: ControlTouchTarget;
  /** 后缀（16px 图标、单位文字或行内图标按钮），距右边 12。 */
  suffix?: ReactNode;
  value?: string;
  variant?: InputVariant;
};

/**
 * 单行输入框（规范 03 §3.2）。`className`、`style` 作用在外框（根元素），其余原生属性透传给 `<input>`，
 * `ref` 指向 `<input>`。在 FormField 内自动获得 id 与 aria 关联。
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    className,
    clearable = false,
    clearLabel,
    defaultValue,
    disabled,
    id,
    invalid,
    onChange,
    onClear,
    onValueChange,
    prefix,
    readOnly = false,
    required,
    size,
    touchTarget,
    style,
    suffix,
    value,
    variant = 'outlined',
    ...props
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRef = useMemo(() => mergeRefs(ref, inputRef), [ref]);
  const control = useFormFieldControl({
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    disabled,
    id,
    invalid,
    required,
  });
  const controlled = value !== undefined;
  const [uncontrolledFilled, setUncontrolledFilled] = useState(
    () => defaultValue !== undefined && defaultValue !== '',
  );
  const filled = controlled ? value !== '' : uncontrolledFilled;
  const showClear =
    clearable && clearLabel !== undefined && filled && !control.disabled && !readOnly;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!controlled) setUncontrolledFilled(event.target.value !== '');
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  const clear = () => {
    const input = inputRef.current;
    if (!input) return;
    setNativeInputValue(input, '');
    input.focus();
    onClear?.();
  };

  // 点在外框的内边距或前后缀上时，把焦点交给输入框（按钮等可交互元素除外）。
  const handleRootMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target === inputRef.current || target.closest('button, a, input, textarea')) return;
    event.preventDefault();
    inputRef.current?.focus();
  };

  return (
    <div
      className={cn('rx-input', 'rx-sized', className)}
      data-disabled={control.disabled ? 'true' : undefined}
      data-filled={filled ? 'true' : undefined}
      data-invalid={control.invalid ? 'true' : undefined}
      data-readonly={readOnly ? 'true' : undefined}
      data-size={size}
      data-touch-target={touchTarget}
      data-variant={variant}
      onMouseDown={handleRootMouseDown}
      style={style}
    >
      {prefix === undefined || prefix === null ? null : (
        <span className="rx-input-affix rx-input-prefix">{prefix}</span>
      )}
      <input
        aria-describedby={control['aria-describedby']}
        aria-invalid={control['aria-invalid']}
        aria-required={control['aria-required']}
        className="rx-input-control"
        defaultValue={controlled ? undefined : defaultValue}
        disabled={control.disabled}
        id={control.id}
        onChange={handleChange}
        readOnly={readOnly}
        ref={setRef}
        required={required}
        value={value}
        {...props}
      />
      {showClear ? (
        <IconButton
          className="rx-input-action rx-input-clear"
          touchTarget={touchTarget}
          icon={<X />}
          label={clearLabel}
          onClick={clear}
          onMouseDown={(event) => event.preventDefault()}
          variant="ghost"
        />
      ) : null}
      {suffix === undefined || suffix === null ? null : (
        <span className="rx-input-affix rx-input-suffix">{suffix}</span>
      )}
    </div>
  );
});
