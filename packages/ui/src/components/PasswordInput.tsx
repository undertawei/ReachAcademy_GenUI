'use client';

import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';

import { cn } from '../cn';
import { useControllableState } from '../primitives/useControllableState';
import { useFormFieldControl } from './FormField';
import { IconButton } from './IconButton';
import { Input, type InputProps } from './Input';

export type PasswordInputProps = Omit<InputProps, 'type'> & {
  defaultVisible?: boolean;
  /** 密码可见时切换按钮的可读名称（例如「隐藏密码」）。 */
  hideLabel: string;
  onVisibleChange?: (visible: boolean) => void;
  /** 密码隐藏时切换按钮的可读名称（例如「显示密码」）。 */
  showLabel: string;
  visible?: boolean;
};

/** 密码输入框：右侧显隐切换图标按钮（规范 03 §3.2）。 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    {
      className,
      defaultVisible = false,
      hideLabel,
      onVisibleChange,
      showLabel,
      suffix,
      visible: visibleProp,
      ...props
    },
    ref,
  ) {
    const [visible, setVisible] = useControllableState({
      defaultValue: defaultVisible,
      onChange: onVisibleChange,
      value: visibleProp,
    });
    const { disabled } = useFormFieldControl({ disabled: props.disabled });
    const toggle: ReactNode = (
      <IconButton
        className="rx-input-action rx-password-input-toggle"
        disabled={disabled}
        icon={visible ? <EyeOff /> : <Eye />}
        label={visible ? hideLabel : showLabel}
        onClick={() => setVisible((current) => !current)}
        onMouseDown={(event) => event.preventDefault()}
        variant="ghost"
      />
    );
    return (
      <Input
        autoCapitalize="off"
        autoCorrect="off"
        className={cn('rx-password-input', className)}
        ref={ref}
        spellCheck={false}
        suffix={
          suffix === undefined || suffix === null ? (
            toggle
          ) : (
            <>
              {suffix}
              {toggle}
            </>
          )
        }
        type={visible ? 'text' : 'password'}
        {...props}
      />
    );
  },
);
