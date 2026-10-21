'use client';

import { Check } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { Spinner } from './Spinner';

/**
 * 规范 03 §3.1。`secondary` 是第一期名称，等同 `default`，保留以兼容存量调用。
 */
export type ButtonVariant =
  | 'accent'
  | 'danger'
  | 'default'
  | 'ghost'
  | 'ink'
  | 'inverse'
  | 'link'
  | 'outline'
  | 'primary'
  | 'secondary';

/** 控件尺寸（规范 03 §1.4）；不传时按角色密度取默认值（教师 md、学生 lg）。 */
export type ControlSize = 'lg' | 'md' | 'sm' | 'xl';

/** 显式启用窄屏触控目标；不传时保留原有尺寸与角色密度。 */
export type ControlTouchTarget = 'responsive';

/** 规范 04 §3.1：请求超过 150ms 才显示 Spinner，Spinner 一旦出现至少保持 400ms。 */
const SPINNER_DELAY_MS = 150;
const SPINNER_MIN_VISIBLE_MS = 400;

export interface ButtonStyleOptions {
  block?: boolean;
  size?: ControlSize;
  touchTarget?: ControlTouchTarget;
  variant?: ButtonVariant;
}

/**
 * 给 `<a>`、Next `<Link>` 等非 button 元素套用按钮外观：
 * `<Link {...buttonStyleProps({ variant: 'ink' })} href="…">`。
 */
export function buttonStyleProps({
  block,
  compactHint,
  size,
  touchTarget,
  variant = 'primary',
}: ButtonStyleOptions & {
  /** Compact, non-interactive action hint inside an already clickable card. */
  compactHint?: boolean;
} = {}) {
  const resolved = variant === 'secondary' ? 'default' : variant;
  return {
    className: cn('rx-button', 'rx-sized', `rx-button-${resolved}`, block && 'rx-button-block'),
    'data-size': size,
    'data-touch-target': touchTarget,
    'data-variant': resolved,
    'data-compact-hint': compactHint || undefined,
  } as const;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  ButtonStyleOptions & {
    /** 文字后的图标（例如「下一步」的 ChevronRight）。 */
    iconEnd?: ReactNode;
    /** 文字前的图标；加载时此位置换成 Spinner。 */
    iconStart?: ReactNode;
    loading?: boolean;
    loadingLabel?: ReactNode;
    /** 页面级「保存」成功态：图标换成勾、文字换成 successLabel（由调用方在约 1.5s 后复原）。 */
    success?: boolean;
    successLabel?: ReactNode;
  };

/**
 * 加载时序（规范 03 §3.1、04 §3.1）：
 * - `busy`：请求一开始就为 true——禁用、aria-busy、文字立即换成 loadingLabel（防重复点击，100ms 内有反馈）；
 * - `spinner`：请求超过 150ms 才为 true（前置图标位置换成 Spinner），出现后至少保持 400ms，快请求不闪。
 * 挂载时就处于加载中（服务端渲染的表单提交等）不是状态切换，直接显示 Spinner。
 */
function useLoadingPhase(loading: boolean): { busy: boolean; spinner: boolean } {
  const [spinner, setSpinner] = useState(loading);
  const shownAt = useRef<number | null>(loading ? Date.now() : null);

  useEffect(() => {
    if (loading) {
      if (shownAt.current !== null) return;
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setSpinner(true);
      }, SPINNER_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    const shown = shownAt.current;
    if (shown === null) {
      setSpinner(false);
      return;
    }
    const remaining = shown + SPINNER_MIN_VISIBLE_MS - Date.now();
    const hide = () => {
      shownAt.current = null;
      setSpinner(false);
    };
    if (remaining <= 0) {
      hide();
      return;
    }
    const timer = window.setTimeout(hide, remaining);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return { busy: loading || spinner, spinner };
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    'aria-busy': ariaBusy,
    block,
    children,
    className,
    disabled = false,
    iconEnd,
    iconStart,
    loading = false,
    loadingLabel,
    size,
    touchTarget,
    success = false,
    successLabel,
    type = 'button',
    variant = 'primary',
    ...props
  },
  ref,
) {
  const { busy, spinner } = useLoadingPhase(loading);
  const style = buttonStyleProps({ block, size, touchTarget, variant });
  const hasIconStart = iconStart !== undefined && iconStart !== null;
  const content = (icon: ReactNode, label: ReactNode) => (
    <>
      {icon === undefined || icon === null ? null : (
        <span aria-hidden="true" className="rx-button-icon">
          {icon}
        </span>
      )}
      {label === undefined || label === null ? null : (
        <span className="rx-button-label">{label}</span>
      )}
      {iconEnd === undefined || iconEnd === null ? null : (
        <span aria-hidden="true" className="rx-button-icon">
          {iconEnd}
        </span>
      )}
    </>
  );

  return (
    <button
      aria-busy={busy ? true : ariaBusy}
      className={cn(style.className, className)}
      data-loading={busy ? 'true' : undefined}
      data-size={style['data-size']}
      data-touch-target={style['data-touch-target']}
      data-state={busy ? 'loading' : success ? 'success' : undefined}
      data-variant={style['data-variant']}
      disabled={disabled || busy}
      ref={ref}
      type={type}
      {...props}
    >
      <span className="rx-button-stack">
        <span aria-hidden={busy || success ? 'true' : undefined} className="rx-button-content">
          {content(iconStart, children)}
        </span>
        {busy ? (
          // 按钮宽度在整个加载过程中不变（规范 03 §3.1）：
          // - 有 iconStart：Spinner 与图标叠在同一格，150ms 后只切换显隐；
          // - 无 iconStart：150ms 前加载层只有文字（与静止态同宽）；Spinner 出现时插在文字前，
          //   加载层两侧各收回半个图标位（见 button.css），对网格宽度的贡献不变，Spinner 落在内边距里。
          <span
            className="rx-button-loading"
            data-inserted-spinner={!hasIconStart && spinner ? 'true' : undefined}
          >
            {content(
              hasIconStart ? (
                <span
                  className="rx-button-loading-icon"
                  data-spinner={spinner ? 'true' : undefined}
                >
                  <span className="rx-button-loading-icon-rest">{iconStart}</span>
                  <Spinner size="sm" />
                </span>
              ) : spinner ? (
                <span className="rx-button-loading-icon" data-spinner="true">
                  <Spinner size="sm" />
                </span>
              ) : null,
              loadingLabel ?? children,
            )}
          </span>
        ) : success ? (
          <span className="rx-button-success">
            {content(<Check className="rx-button-success-icon" />, successLabel ?? children)}
          </span>
        ) : null}
      </span>
    </button>
  );
});
