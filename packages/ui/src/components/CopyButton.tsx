'use client';

import { Check, Copy } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState, type MouseEvent } from 'react';

import { cn } from '../cn';
import { IconButton, type IconButtonProps } from './IconButton';

/** 规范 03 §3.1：复制成功后图标变为勾并保持 1.5s。 */
export const COPIED_DURATION_MS = 1500;

/**
 * 写入剪贴板：优先 Clipboard API；非安全上下文（局域网 http 访问等）没有该 API 时
 * 退回 execCommand('copy')。失败时抛出。
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === 'undefined') throw new Error('clipboard-unavailable');
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.className = 'rx-visually-hidden';
  const active = document.activeElement as HTMLElement | null;
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
    active?.focus?.();
  }
  if (!copied) throw new Error('clipboard-unavailable');
}

export type CopyButtonProps = Omit<IconButtonProps, 'icon' | 'label' | 'loading'> & {
  /** 复制成功后通过 polite 播报区宣读的文字（例如「已复制」）。 */
  copiedLabel: string;
  /** 按钮的可读名称与 Tooltip（例如「复制链接」）。 */
  label: string;
  onCopy?: (text: string) => void;
  onCopyError?: (error: unknown) => void;
  /** 要复制的文本。 */
  text: string;
};

/** 复制按钮（规范 03 §3.1）：成功后图标变勾 1.5s 并播报 `copiedLabel`，不弹 Toast。 */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  {
    className,
    copiedLabel,
    label,
    onClick,
    onCopy,
    onCopyError,
    text,
    variant = 'ghost',
    ...props
  },
  ref,
) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    try {
      await copyTextToClipboard(text);
    } catch (error) {
      if (!mounted.current) return;
      window.clearTimeout(timer.current);
      setCopied(false);
      onCopyError?.(error);
      return;
    }
    if (!mounted.current) return;
    setCopied(true);
    onCopy?.(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_DURATION_MS);
  };

  return (
    <span className={cn('rx-copy-button', className)} data-state={copied ? 'copied' : 'idle'}>
      <IconButton
        icon={copied ? <Check className="rx-copy-button-check" key="check" /> : <Copy key="copy" />}
        label={label}
        onClick={handleClick}
        ref={ref}
        variant={variant}
        {...props}
      />
      <span aria-atomic="true" aria-live="polite" className="rx-visually-hidden" role="status">
        {copied ? copiedLabel : ''}
      </span>
    </span>
  );
});
