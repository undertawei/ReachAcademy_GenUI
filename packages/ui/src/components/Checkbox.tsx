'use client';

import { Check, Minus } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type ForwardedRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import type { ControlSize } from './Button';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type CheckboxGroupContextValue = {
  disabled: boolean;
  invalid: boolean;
  name: string | undefined;
  readOnly: boolean;
  toggle: (value: string, checked: boolean) => void;
  value: readonly string[];
};

const CheckboxGroupContext = createContext<CheckboxGroupContextValue | null>(null);

export type CheckboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'checked' | 'children' | 'defaultChecked' | 'size' | 'type' | 'value'
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  description?: ReactNode;
  /** 半选：`primary` 实心底 + 白色短横，读屏为 mixed。点击后按未选中处理（变为选中）。 */
  indeterminate?: boolean;
  invalid?: boolean;
  label?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  /** 方框边长：sm/md 16px，lg/xl 20px；不传时随角色密度（教师 16、学生 20）。 */
  size?: ControlSize;
  /** 放在 CheckboxGroup 内时必填，作为组值中的一项。 */
  value?: string;
};

export type CheckboxCardProps = Omit<CheckboxProps, 'size'> & {
  /** 标题前的图标位（仅 `variant="card"`）。 */
  icon?: ReactNode;
  /**
   * `card`（默认，选择智能体等）：描边卡片，Checkbox + 图标 + 标题 14/500 + 说明 12。
   * `callout`（「同时开放到平台」这类带说明的勾选框）：`surface-muted`/`surface` 底卡片，标题 16/500 `primary`。
   */
  variant?: 'callout' | 'card';
  /** `callout` 的底色：`muted`（默认）或 `surface`（白底，用于灰色背景上）。 */
  tone?: 'muted' | 'surface';
};

function CheckboxMark() {
  return (
    <span aria-hidden="true" className="rx-checkbox-control">
      <Check className="rx-checkbox-check" strokeWidth={3} />
      <Minus className="rx-checkbox-dash" strokeWidth={3} />
    </span>
  );
}

function useCheckboxInput(
  {
    checked: checkedProp,
    defaultChecked = false,
    description,
    disabled,
    id,
    indeterminate = false,
    invalid,
    label,
    name,
    onChange,
    onCheckedChange,
    readOnly,
    value,
    ...rest
  }: Omit<CheckboxProps, 'className' | 'size'>,
  forwardedRef: ForwardedRef<HTMLInputElement>,
) {
  const group = useContext(CheckboxGroupContext);
  const generatedId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [ownChecked, setOwnChecked] = useControllableState({
    defaultValue: defaultChecked,
    onChange: onCheckedChange,
    value: checkedProp,
  });
  const inGroup = group !== null && value !== undefined;
  const checked = inGroup ? group.value.includes(value) : ownChecked;
  const isDisabled = Boolean(disabled || group?.disabled);
  const isReadOnly = Boolean(readOnly || group?.readOnly);
  const labelId = `${generatedId}-label`;
  const descriptionId = `${generatedId}-description`;
  const hasLabel = label !== undefined && label !== null;
  const hasDescription = description !== undefined && description !== null;

  // `indeterminate` 只能通过 DOM 属性设置；每次渲染都同步，防止原生点击把它清掉后与 props 不一致。
  useIsomorphicLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  });

  const inputProps: InputHTMLAttributes<HTMLInputElement> = {
    ...rest,
    'aria-describedby':
      [hasDescription ? descriptionId : null, rest['aria-describedby']].filter(Boolean).join(' ') ||
      undefined,
    'aria-invalid': invalid || group?.invalid ? true : rest['aria-invalid'],
    'aria-labelledby': rest['aria-labelledby'] ?? (hasLabel ? labelId : undefined),
    'aria-readonly': isReadOnly || undefined,
    checked,
    className: 'rx-checkbox-input rx-visually-hidden',
    disabled: isDisabled,
    id: id ?? `${generatedId}-input`,
    name: name ?? (inGroup ? group.name : undefined),
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      // 原生点击会清掉 indeterminate；以 props 为准恢复，真正的变化由随后的重渲染写回。
      event.target.indeterminate = indeterminate;
      if (isReadOnly) return;
      onChange?.(event);
      if (event.defaultPrevented) return;
      const next = event.target.checked;
      if (inGroup) {
        group.toggle(value, next);
        onCheckedChange?.(next);
      } else {
        setOwnChecked(next);
      }
    },
    type: 'checkbox',
    value,
  };

  return {
    descriptionId,
    hasDescription,
    hasLabel,
    inputProps,
    isDisabled,
    labelId,
    ref: mergeRefs(forwardedRef, inputRef),
    state: indeterminate ? 'indeterminate' : checked ? 'checked' : 'unchecked',
  };
}

/**
 * 复选框（规范 03 §3.8）：真实的 `<input type="checkbox">` 视觉隐藏，整行可点。
 * 受控 `checked` / 非受控 `defaultChecked`，变化回调 `onCheckedChange(checked)`；原生 `onChange` 同样透传。
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, size, ...props },
  ref,
) {
  const { description, label } = props;
  const input = useCheckboxInput(props, ref);
  return (
    <label
      className={cn('rx-checkbox', 'rx-sized', className)}
      data-disabled={input.isDisabled ? '' : undefined}
      data-size={size}
      data-state={input.state}
    >
      <input ref={input.ref} {...input.inputProps} />
      <CheckboxMark />
      {input.hasLabel || input.hasDescription ? (
        <span className="rx-choice-text">
          {input.hasLabel ? (
            <span className="rx-choice-label" id={input.labelId}>
              {label}
            </span>
          ) : null}
          {input.hasDescription ? (
            <span className="rx-choice-description" id={input.descriptionId}>
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
});

/** 卡片式复选项（规范 03 §3.8）：`card` 用于两列选择，`callout` 为「带说明的勾选框」。 */
export const CheckboxCard = forwardRef<HTMLInputElement, CheckboxCardProps>(function CheckboxCard(
  { className, icon, tone = 'muted', variant = 'card', ...props },
  ref,
) {
  const { description, label } = props;
  const input = useCheckboxInput(props, ref);
  return (
    <label
      className={cn('rx-checkbox-card', className)}
      data-disabled={input.isDisabled ? '' : undefined}
      data-state={input.state}
      data-tone={variant === 'callout' ? tone : undefined}
      data-variant={variant}
    >
      <input ref={input.ref} {...input.inputProps} />
      <CheckboxMark />
      {variant === 'card' && icon !== undefined && icon !== null ? (
        <span aria-hidden="true" className="rx-checkbox-card-icon">
          {icon}
        </span>
      ) : null}
      <span className="rx-choice-text">
        {input.hasLabel ? (
          <span className="rx-checkbox-card-title" id={input.labelId}>
            {label}
          </span>
        ) : null}
        {input.hasDescription ? (
          <span className="rx-choice-description" id={input.descriptionId}>
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
});

export interface CheckboxOption {
  description?: ReactNode;
  disabled?: boolean;
  /** 只在 `variant="card"` 时显示。 */
  icon?: ReactNode;
  label: ReactNode;
  value: string;
}

export type CheckboxGroupProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'defaultValue' | 'onChange'
> & {
  children?: ReactNode;
  /** `variant="card"` 的栅格列数，默认 2。 */
  columns?: 1 | 2 | 3 | 4;
  defaultValue?: readonly string[];
  disabled?: boolean;
  invalid?: boolean;
  name?: string;
  onChange?: (value: string[]) => void;
  options?: readonly CheckboxOption[];
  orientation?: 'horizontal' | 'vertical';
  readOnly?: boolean;
  /** 父级「全选」复选框的文案；需要配合 `options` 使用（按可用选项计算选中/半选）。 */
  selectAllLabel?: ReactNode;
  size?: ControlSize;
  value?: readonly string[];
  variant?: 'card' | 'default';
};

const EMPTY: readonly string[] = [];

/**
 * 复选组（规范 03 §3.8）：值为字符串数组；可选父级「全选」（半选态）。纵向间距 12。
 * 禁用选项不受「全选」影响，保持原有选中状态。
 */
export const CheckboxGroup = forwardRef<HTMLDivElement, CheckboxGroupProps>(function CheckboxGroup(
  {
    children,
    className,
    columns = 2,
    defaultValue = EMPTY,
    disabled = false,
    invalid = false,
    name,
    onChange,
    options,
    orientation = 'vertical',
    readOnly = false,
    selectAllLabel,
    size,
    value: valueProp,
    variant = 'default',
    ...props
  },
  ref,
) {
  const [value, setValue] = useControllableState<readonly string[]>({
    defaultValue,
    onChange: (next) => onChange?.([...next]),
    value: valueProp,
  });

  const order = options?.map((option) => option.value);
  const normalize = (next: readonly string[]) =>
    order
      ? [
          ...order.filter((item) => next.includes(item)),
          ...next.filter((item) => !order.includes(item)),
        ]
      : [...next];

  const toggle = (item: string, checked: boolean) =>
    setValue((current) =>
      checked
        ? current.includes(item)
          ? current
          : normalize([...current, item])
        : current.filter((entry) => entry !== item),
    );

  const enabledValues = (options ?? [])
    .filter((option) => !option.disabled)
    .map((option) => option.value);
  const selectedEnabled = enabledValues.filter((item) => value.includes(item));
  const allSelected = enabledValues.length > 0 && selectedEnabled.length === enabledValues.length;
  const someSelected = selectedEnabled.length > 0 && !allSelected;
  const showSelectAll =
    selectAllLabel !== undefined && selectAllLabel !== null && options !== undefined;
  const isCard = variant === 'card';

  const items = options?.map((option) =>
    isCard ? (
      <CheckboxCard
        description={option.description}
        disabled={option.disabled}
        icon={option.icon}
        key={option.value}
        label={option.label}
        value={option.value}
      />
    ) : (
      <Checkbox
        description={option.description}
        disabled={option.disabled}
        key={option.value}
        label={option.label}
        value={option.value}
      />
    ),
  );

  return (
    <CheckboxGroupContext.Provider value={{ disabled, invalid, name, readOnly, toggle, value }}>
      <div
        aria-disabled={disabled || undefined}
        aria-invalid={invalid || undefined}
        className={cn('rx-checkbox-group', 'rx-sized', className)}
        data-columns={isCard ? columns : undefined}
        data-orientation={isCard ? undefined : orientation}
        data-size={size}
        data-variant={variant}
        ref={ref}
        role="group"
        {...props}
      >
        {showSelectAll ? (
          <Checkbox
            checked={allSelected}
            className="rx-checkbox-group-all"
            disabled={disabled || enabledValues.length === 0}
            indeterminate={someSelected}
            label={selectAllLabel}
            onCheckedChange={(checked) =>
              setValue((current) =>
                checked
                  ? normalize([
                      ...current,
                      ...enabledValues.filter((item) => !current.includes(item)),
                    ])
                  : current.filter((item) => !enabledValues.includes(item)),
              )
            }
            readOnly={readOnly}
          />
        ) : null}
        <div className="rx-checkbox-group-items" data-nested={showSelectAll ? '' : undefined}>
          {items}
          {children}
        </div>
      </div>
    </CheckboxGroupContext.Provider>
  );
});
