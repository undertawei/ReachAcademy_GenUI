'use client';

import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import type { ControlSize } from './Button';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type RadioGroupContextValue = {
  disabled: boolean;
  invalid: boolean;
  name: string;
  readOnly: boolean;
  required: boolean;
  select: (value: string) => void;
  value: string | null;
};

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export type RadioProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'children' | 'size' | 'type' | 'value'
> & {
  description?: ReactNode;
  invalid?: boolean;
  label?: ReactNode;
  /** 单选框外径：sm/md 16px，lg/xl 20px；不传时随角色密度（教师 16、学生 20）。 */
  size?: ControlSize;
  value: string;
};

export type RadioCardProps = Omit<RadioProps, 'size'> & {
  /** 左侧 32px 图标位（lucide 图标或模块类型图标）。 */
  icon?: ReactNode;
};

/** Radio 与 RadioCard 共用：组内由 RadioGroup 决定 name/checked/disabled，组外即普通原生单选框。 */
function useRadioInput({
  checked,
  description,
  disabled,
  id,
  invalid,
  label,
  name,
  onChange,
  readOnly,
  required,
  value,
  ...rest
}: Omit<RadioProps, 'size' | 'className'>) {
  const group = useContext(RadioGroupContext);
  const generatedId = useId();
  const inputId = id ?? `${generatedId}-input`;
  const labelId = `${generatedId}-label`;
  const descriptionId = `${generatedId}-description`;
  const isDisabled = Boolean(disabled || group?.disabled);
  const isReadOnly = Boolean(readOnly || group?.readOnly);
  const isChecked = group ? group.value === value : checked;
  const describedBy =
    [
      description === undefined || description === null ? null : descriptionId,
      rest['aria-describedby'],
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  const inputProps: InputHTMLAttributes<HTMLInputElement> & { 'data-rx-radio': string } = {
    ...rest,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || group?.invalid ? true : rest['aria-invalid'],
    'aria-labelledby':
      rest['aria-labelledby'] ?? (label === undefined || label === null ? undefined : labelId),
    'aria-readonly': isReadOnly || undefined,
    checked: isChecked,
    className: 'rx-radio-input rx-visually-hidden',
    'data-rx-radio': '',
    disabled: isDisabled,
    id: inputId,
    name: group ? group.name : name,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      if (isReadOnly) return;
      onChange?.(event);
      if (group && !event.defaultPrevented && event.target.checked) group.select(value);
    },
    required: required || group?.required,
    type: 'radio',
    value,
  };

  return {
    descriptionId,
    inputProps,
    isChecked,
    isDisabled,
    labelId,
  };
}

function stateOf(checked: boolean | undefined) {
  if (checked === undefined) return undefined;
  return checked ? 'checked' : 'unchecked';
}

/**
 * 单选框（规范 03 §3.7）：真实的 `<input type="radio">` 视觉隐藏，整行（含说明）可点。
 * 放在 RadioGroup 内时由组提供 name、选中值与方向键行为。
 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { className, size, ...props },
  ref,
) {
  const { description, label } = props;
  const { descriptionId, inputProps, isChecked, isDisabled, labelId } = useRadioInput(props);
  return (
    <label
      className={cn('rx-radio', 'rx-sized', className)}
      data-disabled={isDisabled ? '' : undefined}
      data-size={size}
      data-state={stateOf(isChecked)}
    >
      <input ref={ref} {...inputProps} />
      <span aria-hidden="true" className="rx-radio-control" />
      {label === undefined && description === undefined ? null : (
        <span className="rx-choice-text">
          {label === undefined || label === null ? null : (
            <span className="rx-choice-label" id={labelId}>
              {label}
            </span>
          )}
          {description === undefined || description === null ? null : (
            <span className="rx-choice-description" id={descriptionId}>
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
});

/**
 * 卡片式单选项（规范 03 §3.7，模块类型选择等）：卡片本身即选项，不再显示圆点。
 * 通常通过 `<RadioGroup variant="card" options={…}>` 以三列栅格排布。
 */
export const RadioCard = forwardRef<HTMLInputElement, RadioCardProps>(function RadioCard(
  { className, icon, ...props },
  ref,
) {
  const { description, label } = props;
  const { descriptionId, inputProps, isChecked, isDisabled, labelId } = useRadioInput(props);
  return (
    <label
      className={cn('rx-radio-card', className)}
      data-disabled={isDisabled ? '' : undefined}
      data-state={stateOf(isChecked)}
    >
      <input ref={ref} {...inputProps} />
      {icon === undefined || icon === null ? null : (
        <span aria-hidden="true" className="rx-radio-card-icon">
          {icon}
        </span>
      )}
      <span className="rx-choice-text">
        {label === undefined || label === null ? null : (
          <span className="rx-radio-card-title" id={labelId}>
            {label}
          </span>
        )}
        {description === undefined || description === null ? null : (
          <span className="rx-choice-description" id={descriptionId}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
});

export interface RadioOption {
  description?: ReactNode;
  disabled?: boolean;
  /** 只在 `variant="card"` 时显示。 */
  icon?: ReactNode;
  label: ReactNode;
  value: string;
}

export type RadioGroupProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'defaultValue' | 'onChange'
> & {
  children?: ReactNode;
  /** `variant="card"` 的栅格列数，默认 3。 */
  columns?: 1 | 2 | 3 | 4;
  defaultValue?: string | null;
  disabled?: boolean;
  invalid?: boolean;
  /** 表单字段名；不传时自动生成，保证同组原生单选框互斥。 */
  name?: string;
  onChange?: (value: string) => void;
  /** 选项数据；也可以直接写 `<Radio>` / `<RadioCard>` 子元素。 */
  options?: readonly RadioOption[];
  /** 纵向（间距 12，默认）或横向（间距 24）；卡片变体始终为栅格。 */
  orientation?: 'horizontal' | 'vertical';
  readOnly?: boolean;
  required?: boolean;
  size?: ControlSize;
  /** 受控值；`null` 表示受控且未选中。 */
  value?: string | null;
  variant?: 'card' | 'default';
};

const NEXT_KEYS: Record<string, number> = {
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
};

function groupRadios(root: HTMLElement): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[data-rx-radio]')).filter(
    (input) => input.closest('[role="radiogroup"]') === root,
  );
}

/**
 * 单选组（规范 03 §3.7，APG radio group）：Tab 只进出整组一次（选中项，未选时第一项），
 * 方向键在可用选项间循环移动并选中。
 */
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    children,
    className,
    columns = 3,
    defaultValue = null,
    disabled = false,
    invalid = false,
    name,
    onChange,
    onKeyDown,
    options,
    orientation = 'vertical',
    readOnly = false,
    required = false,
    size,
    value: valueProp,
    variant = 'default',
    ...props
  },
  ref,
) {
  const generatedName = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useControllableState<string | null>({
    defaultValue,
    onChange: (next) => {
      if (next !== null) onChange?.(next);
    },
    value: valueProp,
  });

  // 漫游 tabindex：只有选中项（或第一项可用项）可被 Tab 聚焦。原生 name 分组在各浏览器的
  // 未选中态行为不一致，这里显式写 DOM tabIndex（Radio 本身不设置 tabIndex 属性）。
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const radios = groupRadios(root);
    const enabled = radios.filter((input) => !input.disabled);
    const stop = enabled.find((input) => input.checked) ?? enabled[0];
    for (const input of radios) input.tabIndex = input === stop ? 0 : -1;
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    const delta = NEXT_KEYS[event.key];
    const root = rootRef.current;
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || delta === undefined || !root) return;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute('data-rx-radio')) return;
    const enabled = groupRadios(root).filter((input) => !input.disabled);
    const index = enabled.indexOf(target);
    if (index < 0 || enabled.length === 0) return;
    event.preventDefault();
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    next.focus();
    if (!readOnly) setValue(next.value);
  };

  const isCard = variant === 'card';

  return (
    <RadioGroupContext.Provider
      value={{
        disabled,
        invalid,
        name: name ?? generatedName,
        readOnly,
        required,
        select: (next) => setValue(next),
        value,
      }}
    >
      <div
        aria-disabled={disabled || undefined}
        aria-invalid={invalid || undefined}
        aria-orientation={isCard ? undefined : orientation}
        aria-readonly={readOnly || undefined}
        aria-required={required || undefined}
        className={cn('rx-radio-group', 'rx-sized', className)}
        data-columns={isCard ? columns : undefined}
        data-orientation={isCard ? undefined : orientation}
        data-size={size}
        data-variant={variant}
        onKeyDown={handleKeyDown}
        ref={mergeRefs(ref, rootRef)}
        role="radiogroup"
        {...props}
      >
        {options?.map((option) =>
          isCard ? (
            <RadioCard
              description={option.description}
              disabled={option.disabled}
              icon={option.icon}
              key={option.value}
              label={option.label}
              value={option.value}
            />
          ) : (
            <Radio
              description={option.description}
              disabled={option.disabled}
              key={option.value}
              label={option.label}
              value={option.value}
            />
          ),
        )}
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
});
