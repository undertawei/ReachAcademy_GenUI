'use client';

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { useControllableState } from '../primitives/useControllableState';
import { Spinner } from './Spinner';

export type SwitchSize = 'md' | 'sm';

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'defaultChecked' | 'onChange' | 'role' | 'type' | 'value'
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  /** 外部控制的加载态（请求中）：滑块内显示 Spinner，不可切换。 */
  loading?: boolean;
  /** 表单提交字段名：开启时随表单提交 `value`（默认 `on`），关闭时不提交。 */
  name?: string;
  /**
   * 切换回调。返回 Promise 时开关乐观翻转并显示加载，resolve 后保留新值，reject 时回弹并调用 `onError`。
   * 受控用法下，调用方应在 Promise resolve 之前（或同时）更新 `checked`。
   */
  onCheckedChange?: (checked: boolean) => unknown;
  /** 异步切换失败时调用（开关已回弹），用于就地提示或 Toast。 */
  onError?: (error: unknown) => void;
  readOnly?: boolean;
  /** 轨道 38×18（md，默认）/ 28×16（sm）。 */
  size?: SwitchSize;
  value?: string;
};

/**
 * 开关（规范 03 §3.9，动效 04 §3.11）：`role="switch"` 的按钮，滑块平移 `fast` + `easing-emphasized`。
 * 立即生效的开关把请求作为 `onCheckedChange` 的返回值交给组件：请求期间滑块内转圈，失败回弹。
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked: checkedProp,
    className,
    defaultChecked = false,
    disabled = false,
    loading = false,
    name,
    onCheckedChange,
    onClick,
    onError,
    readOnly = false,
    size,
    value = 'on',
    ...props
  },
  ref,
) {
  const [committed, setCommitted] = useControllableState({
    defaultValue: defaultChecked,
    value: checkedProp,
  });
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const checked = optimistic ?? committed;
  const pending = optimistic !== null;
  const busy = loading || pending;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || disabled || readOnly || busy) return;
    const next = !checked;
    let result: unknown;
    try {
      result = onCheckedChange?.(next);
    } catch (error) {
      if (!onError) throw error;
      onError(error);
      return;
    }
    if (!isPromiseLike(result)) {
      setCommitted(next);
      return;
    }
    setOptimistic(next);
    result.then(
      () => {
        if (!mounted.current) return;
        setCommitted(next);
        setOptimistic(null);
      },
      (error: unknown) => {
        if (!mounted.current) return;
        setOptimistic(null);
        onError?.(error);
      },
    );
  };

  return (
    <>
      <button
        aria-busy={busy || undefined}
        aria-checked={checked}
        aria-disabled={busy || readOnly ? true : undefined}
        aria-readonly={readOnly || undefined}
        className={cn('rx-switch', 'rx-sized', className)}
        data-loading={busy ? 'true' : undefined}
        data-size={size}
        data-state={checked ? 'checked' : 'unchecked'}
        disabled={disabled}
        onClick={handleClick}
        ref={ref}
        role="switch"
        type="button"
        {...props}
      >
        <span aria-hidden="true" className="rx-switch-thumb">
          {busy ? <Spinner className="rx-switch-spinner" size="sm" /> : null}
        </span>
      </button>
      {name !== undefined && checked ? <input name={name} type="hidden" value={value} /> : null}
    </>
  );
});

export type SettingRowProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'title'> &
  Pick<
    SwitchProps,
    | 'checked'
    | 'defaultChecked'
    | 'disabled'
    | 'loading'
    | 'name'
    | 'onError'
    | 'readOnly'
    | 'size'
    | 'value'
  > & {
    /** 附属输入（通过分数、限时分钟）：放在说明下方，开关关闭时整体禁用。 */
    children?: ReactNode;
    description?: ReactNode;
    /** 同 Switch：可返回 Promise 实现立即生效（乐观翻转，失败回弹）。 */
    onCheckedChange?: (checked: boolean) => unknown;
    /** 标题描述「开启后的效果」（如「需教师批阅」），不要写「是否…」。 */
    title: ReactNode;
  };

/**
 * 设置行（规范 03 §3.9）：左侧标题 14/500 + 说明 12，右侧开关右对齐。
 * 附属输入放在说明下方的 `<fieldset>` 里，开关关闭（或整行禁用）时原生禁用其中全部控件。
 */
export const SettingRow = forwardRef<HTMLDivElement, SettingRowProps>(function SettingRow(
  {
    checked: checkedProp,
    children,
    className,
    defaultChecked = false,
    description,
    disabled = false,
    loading,
    name,
    onCheckedChange,
    onError,
    readOnly,
    size,
    title,
    value,
    ...props
  },
  ref,
) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const [checked, setChecked] = useControllableState({
    defaultValue: defaultChecked,
    value: checkedProp,
  });
  const hasDescription = description !== undefined && description !== null;
  const hasChildren = children !== undefined && children !== null && children !== false;

  return (
    <div
      className={cn('rx-setting-row', className)}
      data-disabled={disabled ? '' : undefined}
      data-state={checked ? 'checked' : 'unchecked'}
      ref={ref}
      {...props}
    >
      <div className="rx-setting-row-main">
        <div className="rx-setting-row-title" id={titleId}>
          {title}
        </div>
        {hasDescription ? (
          <div className="rx-setting-row-description" id={descriptionId}>
            {description}
          </div>
        ) : null}
        {hasChildren ? (
          <fieldset className="rx-setting-row-attachments" disabled={disabled || !checked}>
            {children}
          </fieldset>
        ) : null}
      </div>
      <Switch
        aria-describedby={hasDescription ? descriptionId : undefined}
        aria-labelledby={titleId}
        checked={checked}
        className="rx-setting-row-switch"
        disabled={disabled}
        loading={loading}
        name={name}
        onCheckedChange={(next) => {
          const result = onCheckedChange?.(next);
          if (!isPromiseLike(result)) {
            setChecked(next);
            return result;
          }
          return Promise.resolve(result).then(() => setChecked(next));
        }}
        onError={onError}
        readOnly={readOnly}
        size={size}
        value={value}
      />
    </div>
  );
});

export type SettingGridProps = HTMLAttributes<HTMLDivElement>;

/** 设置行栅格（规范 03 §3.9）：宽屏两列，列间距 40、行间距 20；窄屏单列。 */
export const SettingGrid = forwardRef<HTMLDivElement, SettingGridProps>(function SettingGrid(
  { className, ...props },
  ref,
) {
  return <div className={cn('rx-setting-grid', className)} ref={ref} {...props} />;
});
