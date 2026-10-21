'use client';

import { Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { cn } from '../cn';
import { Button } from './Button';
import { ConfirmIcon, Dialog } from './Dialog';

export type ConfirmDialogProps = {
  /** 确认进行中：主按钮 loading，其余控件禁用，任何方式都不能关闭。 */
  busy?: boolean;
  busyLabel?: ReactNode;
  cancelLabel?: ReactNode;
  className?: string;
  confirmLabel: ReactNode;
  /**
   * 高风险不可恢复操作：用户须输入与之完全一致的文字（首尾空白忽略）才能确认。
   * 需同时传 `confirmationInputLabel`。
   */
  confirmationText?: string;
  /** 确认输入框的可见标签，例如「输入课程名称“高中数学”以确认」。 */
  confirmationInputLabel?: ReactNode;
  /** 说明影响范围、能否恢复。 */
  description?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  /** 直接陈述后果，例如「删除课程“高中数学”？」。 */
  title: ReactNode;
  /** `danger`：危险图标，主按钮带垃圾桶图标（规范 01 §2.4：危险操作与品牌色同色相，必须带图标）。 */
  tone?: 'danger' | 'default';
};

/**
 * 阻断式确认框（规范 03 §3.15）：`sm` 尺寸，`role="alertdialog"`，默认聚焦「取消」。
 * Esc / 点遮罩等同取消（busy 时不响应），关闭后焦点回到打开前的元素。
 */
export function ConfirmDialog({
  busy = false,
  busyLabel,
  cancelLabel,
  className,
  confirmLabel,
  confirmationInputLabel,
  confirmationText,
  description,
  onCancel,
  onConfirm,
  open,
  title,
  tone = 'default',
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const requiresTyping = confirmationText !== undefined && confirmationText !== '';
  const typedMatches = !requiresTyping || typed.trim() === confirmationText.trim();

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  return (
    <Dialog
      className={cn('rx-confirm-dialog', className)}
      data-tone={tone}
      description={description}
      dismissible={!busy}
      footer={
        <>
          {cancelLabel === undefined ? null : (
            <Button disabled={busy} onClick={onCancel} ref={cancelRef} size="md" variant="default">
              {cancelLabel}
            </Button>
          )}
          <Button
            disabled={!typedMatches}
            iconStart={tone === 'danger' ? <Trash2 strokeWidth={1.5} /> : undefined}
            loading={busy}
            loadingLabel={busyLabel ?? confirmLabel}
            onClick={onConfirm}
            ref={confirmRef}
            size="md"
            variant="primary"
          >
            {confirmLabel}
          </Button>
        </>
      }
      icon={<ConfirmIcon tone={tone} />}
      initialFocus={requiresTyping ? inputRef : cancelLabel === undefined ? confirmRef : cancelRef}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      open={open}
      role="alertdialog"
      size="sm"
      title={title}
    >
      {requiresTyping ? (
        <div className="rx-confirm-dialog-field">
          {confirmationInputLabel === undefined ? null : (
            <label className="rx-confirm-dialog-label" htmlFor={inputId}>
              {confirmationInputLabel}
            </label>
          )}
          <input
            autoComplete="off"
            className="rx-confirm-dialog-input"
            disabled={busy}
            id={inputId}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && typedMatches && !busy) {
                event.preventDefault();
                onConfirm();
              }
            }}
            ref={inputRef}
            spellCheck={false}
            type="text"
            value={typed}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
