'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  forwardRef,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import { useFormFieldControl } from './FormField';
import { Input, type InputProps } from './Input';

export type NumberInputProps = Omit<
  InputProps,
  | 'clearLabel'
  | 'clearable'
  | 'defaultValue'
  | 'inputMode'
  | 'max'
  | 'min'
  | 'onChange'
  | 'onClear'
  | 'onValueChange'
  | 'step'
  | 'type'
  | 'value'
> & {
  /** 「减少」步进按钮的可读名称。 */
  decrementLabel: string;
  defaultValue?: number | null;
  /** 范围提示（「请输入 1 到 100 之间的整数」），放在单位之后。 */
  hint?: ReactNode;
  /** 「增加」步进按钮的可读名称。 */
  incrementLabel: string;
  max?: number;
  min?: number;
  /** 值变化；清空时为 null。输入过程中即回调，失焦时再按 min/max 夹取。 */
  onChange?: (value: number | null) => void;
  /** 失焦时输入值超出范围被夹取：`clamped` 为夹取后的值，`raw` 为用户输入的值。调用方据此提示。 */
  onClamp?: (clamped: number, raw: number) => void;
  /** 小数位数；设置后失焦与步进结果按此位数取整并补零显示。 */
  precision?: number;
  /** 步长，默认 1；Shift + ↑/↓ 或 PageUp/PageDown 为 ×10。 */
  step?: number;
  /** 单位（分钟、%），放在控件外右侧。 */
  unit?: ReactNode;
  value?: number | null;
};

const FULL_WIDTH: Record<string, string> = { '．': '.', '－': '-', '。': '.' };

/** 把全角数字与符号（中文输入法常见）转成半角。 */
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[．－。]/g, (symbol) => FULL_WIDTH[symbol] ?? symbol)
    .trim();
}

function parse(text: string): number | null {
  if (text === '' || text === '-' || text === '.' || text === '-.') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimalsOf(value: number): number {
  const text = String(value);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(Math.min(decimals, 100)));
}

/**
 * 数字输入框（规范 03 §3.2）：右侧上下步进箭头，↑/↓ 步进（Shift ×10），Home/End 跳到 min/max；
 * 失焦时夹到 min/max 并回调 `onClamp`；单位与范围提示在控件外右侧。
 * `className`、`style` 作用在根元素（控件 + 单位 + 提示），`ref` 指向 `<input>`。
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    'aria-describedby': ariaDescribedBy,
    className,
    decrementLabel,
    defaultValue,
    disabled,
    hint,
    incrementLabel,
    max,
    min,
    onBlur,
    onChange,
    onClamp,
    onKeyDown,
    precision,
    readOnly = false,
    size,
    step = 1,
    style,
    unit,
    value,
    variant,
    ...props
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRef = useMemo(() => mergeRefs(ref, inputRef), [ref]);
  const baseId = useId();
  const unitId = `${baseId}-unit`;
  const hintId = `${baseId}-hint`;
  const hasUnit = unit !== undefined && unit !== null && unit !== '';
  const hasHint = hint !== undefined && hint !== null && hint !== '';
  const [current, setCurrent] = useControllableState<number | null>({
    defaultValue: defaultValue ?? null,
    onChange,
    value,
  });
  // 正在编辑的原始文本；null 表示按当前值格式化显示。
  const [draft, setDraft] = useState<string | null>(null);
  const { disabled: fieldDisabled } = useFormFieldControl({ disabled });
  const inert = fieldDisabled || readOnly;

  const allowNegative = min === undefined || min < 0;
  const allowDecimal = precision === undefined || precision > 0;
  const pattern = new RegExp(
    `^${allowNegative ? '-?' : ''}\\d*${allowDecimal ? '(\\.\\d*)?' : ''}$`,
  );

  const format = (number: number | null) =>
    number === null ? '' : precision === undefined ? String(number) : number.toFixed(precision);
  const clamp = (number: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number));
  const display = draft ?? format(current);

  const commit = () => {
    if (draft === null) return;
    const parsed = parse(draft);
    setDraft(null);
    if (parsed === null) {
      setCurrent(null);
      return;
    }
    const rounded = precision === undefined ? parsed : roundTo(parsed, precision);
    const clamped = clamp(rounded);
    setCurrent(clamped);
    if (clamped !== rounded) onClamp?.(clamped, parsed);
  };

  const stepBy = (direction: 1 | -1, multiplier: number) => {
    if (inert) return;
    const base = draft === null ? current : parse(draft);
    const decimals = precision ?? Math.max(decimalsOf(step), base === null ? 0 : decimalsOf(base));
    const next =
      base === null ? clamp(0) : clamp(roundTo(base + direction * step * multiplier, decimals));
    setDraft(null);
    setCurrent(next);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const text = normalize(event.target.value);
    if (!pattern.test(text)) return;
    setDraft(text);
    if (text === '') setCurrent(null);
    else {
      const parsed = parse(text);
      if (parsed !== null) setCurrent(parsed);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || inert) return;
    const multiplier = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        stepBy(1, multiplier);
        break;
      case 'ArrowDown':
        event.preventDefault();
        stepBy(-1, multiplier);
        break;
      case 'PageUp':
        event.preventDefault();
        stepBy(1, 10);
        break;
      case 'PageDown':
        event.preventDefault();
        stepBy(-1, 10);
        break;
      case 'Home':
        if (min === undefined) break;
        event.preventDefault();
        setDraft(null);
        setCurrent(min);
        break;
      case 'End':
        if (max === undefined) break;
        event.preventDefault();
        setDraft(null);
        setCurrent(max);
        break;
      case 'Enter':
        commit();
        break;
      default:
    }
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    commit();
    onBlur?.(event);
  };

  const stepper = (direction: 1 | -1) => {
    const atLimit =
      current !== null &&
      (direction === 1 ? max !== undefined && current >= max : min !== undefined && current <= min);
    return (
      <button
        aria-label={direction === 1 ? incrementLabel : decrementLabel}
        className="rx-number-input-step"
        data-direction={direction === 1 ? 'up' : 'down'}
        disabled={inert || atLimit}
        onClick={() => {
          stepBy(direction, 1);
          inputRef.current?.focus();
        }}
        onMouseDown={(event) => event.preventDefault()}
        tabIndex={-1}
        type="button"
      >
        {direction === 1 ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </button>
    );
  };

  return (
    <div className={cn('rx-number-input', 'rx-sized', className)} data-size={size} style={style}>
      <Input
        aria-describedby={cn(ariaDescribedBy, hasUnit && unitId, hasHint && hintId) || undefined}
        aria-valuemax={max}
        aria-valuemin={min}
        aria-valuenow={current ?? undefined}
        autoComplete="off"
        className="rx-number-input-box"
        disabled={disabled}
        inputMode={allowDecimal ? 'decimal' : 'numeric'}
        onBlur={handleBlur}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        readOnly={readOnly}
        ref={setRef}
        role="spinbutton"
        suffix={
          <span className="rx-number-input-steppers">
            {stepper(1)}
            {stepper(-1)}
          </span>
        }
        type="text"
        value={display}
        variant={variant}
        {...props}
      />
      {hasUnit ? (
        <span className="rx-number-input-unit" id={unitId}>
          {unit}
        </span>
      ) : null}
      {hasHint ? (
        <span className="rx-number-input-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
});
