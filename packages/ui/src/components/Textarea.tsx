'use client';

import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type TextareaHTMLAttributes,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import type { ControlSize } from './Button';
import { useFormFieldControl } from './FormField';
import type { InputVariant } from './Input';

export interface TextareaAutoSize {
  maxRows?: number;
  minRows?: number;
}

export type TextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'defaultValue' | 'maxLength' | 'value'
> & {
  /** 自动增高：从 minRows 长到 maxRows，超过后内部滚动（此时不可手动拉伸）。 */
  autoSize?: boolean | TextareaAutoSize;
  /** 计数的读屏描述，例如 `(count, max) => \`已输入 ${count} 字，上限 ${max} 字\``。 */
  countLabel?: (count: number, max: number) => string;
  defaultValue?: string;
  invalid?: boolean;
  /**
   * 长度上限：右下角显示 `12/75`，超限时计数变 danger 且控件 aria-invalid。
   * 不截断输入（不写原生 maxlength），由调用方在提交时拦截。
   */
  maxCount?: number;
  onValueChange?: (value: string) => void;
  size?: ControlSize;
  value?: string;
  variant?: InputVariant;
};

/** 按「字」计数：代理对（emoji 等）算 1 个。 */
export function countCharacters(value: string): number {
  return Array.from(value).length;
}

function resolveAutoSize(autoSize: TextareaProps['autoSize'], rows: number) {
  if (!autoSize) return null;
  const options = autoSize === true ? {} : autoSize;
  const minRows = Math.max(1, options.minRows ?? rows);
  const maxRows = options.maxRows === undefined ? Infinity : Math.max(minRows, options.maxRows);
  return { maxRows, minRows };
}

/**
 * 多行输入框（规范 03 §3.2）：默认 3 行，只允许纵向拉伸。`className`、`style` 作用在外框，
 * 其余原生属性透传给 `<textarea>`，`ref` 指向 `<textarea>`。
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    autoSize,
    className,
    countLabel,
    defaultValue,
    disabled,
    id,
    invalid,
    maxCount,
    onChange,
    onValueChange,
    readOnly = false,
    required,
    rows = 3,
    size,
    style,
    value,
    variant = 'outlined',
    ...props
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useMemo(() => mergeRefs(ref, textareaRef), [ref]);
  const countId = useId();
  const controlled = value !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '');
  const current = controlled ? value : uncontrolledValue;
  const count = maxCount === undefined ? 0 : countCharacters(current);
  const overLimit = maxCount !== undefined && count > maxCount;
  const hasCountLabel = maxCount !== undefined && countLabel !== undefined;
  const control = useFormFieldControl({
    'aria-describedby': hasCountLabel ? cn(ariaDescribedBy, countId) : ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    disabled,
    id,
    invalid: invalid || overLimit || undefined,
    required,
  });
  const sizing = resolveAutoSize(autoSize, rows);
  const minRows = sizing?.minRows;
  const maxRows = sizing?.maxRows;

  const resize = useCallback(() => {
    const element = textareaRef.current;
    if (!element || minRows === undefined || maxRows === undefined) return;
    const computed = window.getComputedStyle(element);
    const fontSize = parseFloat(computed.fontSize) || 14;
    const lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.5;
    const border =
      (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
    const chrome =
      (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0) + border;
    const min = minRows * lineHeight + chrome;
    const max = maxRows * lineHeight + chrome;
    // 先收缩再量 scrollHeight（含内边距、不含描边），删字时才能变矮。
    element.style.height = 'auto';
    const content = element.scrollHeight + border;
    const next = Math.min(Math.max(content, min), max);
    element.style.height = `${next}px`;
    element.style.overflowY = content > max ? 'auto' : 'hidden';
  }, [maxRows, minRows]);

  useLayoutEffect(() => {
    resize();
  }, [current, resize]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (!controlled) setUncontrolledValue(event.target.value);
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  return (
    <div
      className={cn('rx-textarea', 'rx-input', 'rx-sized', className)}
      data-autosize={sizing ? 'true' : undefined}
      data-disabled={control.disabled ? 'true' : undefined}
      data-invalid={control.invalid ? 'true' : undefined}
      data-readonly={readOnly ? 'true' : undefined}
      data-size={size}
      data-variant={variant}
      style={style}
    >
      <textarea
        aria-describedby={control['aria-describedby']}
        aria-invalid={control['aria-invalid']}
        aria-required={control['aria-required']}
        className="rx-textarea-control rx-scroll-y"
        defaultValue={controlled ? undefined : defaultValue}
        disabled={control.disabled}
        id={control.id}
        onChange={handleChange}
        readOnly={readOnly}
        ref={setRef}
        required={required}
        rows={minRows ?? rows}
        value={value}
        {...props}
      />
      {maxCount === undefined ? null : (
        <div className="rx-textarea-footer">
          <span
            aria-hidden="true"
            className="rx-textarea-count rx-numeric"
            data-over-limit={overLimit ? 'true' : undefined}
          >
            {count}/{maxCount}
          </span>
          {hasCountLabel ? (
            <span className="rx-visually-hidden" id={countId}>
              {countLabel(count, maxCount)}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
});
