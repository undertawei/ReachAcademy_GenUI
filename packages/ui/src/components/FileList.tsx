'use client';

import { ArrowDown, ArrowUp, Files, RotateCw, Trash2, X } from 'lucide-react';
import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';
import { Button } from './Button';
import { useFilePicker, type UploadRejection } from './Dropzone';
import { IconButton } from './IconButton';

/**
 * - `queued`：已选择，等待上传名额；
 * - `uploading`：上传中（显示细进度条，可取消）；
 * - `pending`：已上传、待保存（`success` 字色，规范 03 §3.29「待保存」）；
 * - `failed`：失败（显示错误与重试）；
 * - `done`：已保存，不显示状态文字（可用 `doneLabel` 覆盖）。
 */
export type FileListItemStatus = 'done' | 'failed' | 'pending' | 'queued' | 'uploading';

export interface FileListItem {
  /** 失败原因（就地显示在该行）；缺省时显示 `failedLabel`。 */
  error?: ReactNode;
  id: string;
  name: string;
  /** 上传进度 0–100。 */
  progress?: number;
  /** 字节数。 */
  size: number;
  status: FileListItemStatus;
}

export type FileListProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  /** 「选择多个文件」按钮使用的 accept。 */
  accept?: string;
  /** 「取消上传」按钮的可读名称。 */
  cancelLabel: string;
  disabled?: boolean;
  doneLabel?: ReactNode;
  failedLabel: ReactNode;
  /** 底部说明（大小与数量限制）。 */
  footer?: ReactNode;
  /** 自定义大小格式化；默认用 `Intl.NumberFormat(locale, { style: 'unit' })` 输出 B/KB/MB/GB。 */
  formatSize?: (bytes: number) => string;
  items: readonly FileListItem[];
  locale?: string;
  /** 最多文件数，同时用于标题计数与选择时的数量校验。 */
  max?: number;
  /** 单个文件最大字节数（选择时校验）。 */
  maxSize?: number;
  moveDownLabel: string;
  moveUpLabel: string;
  onCancel?: (id: string) => void;
  /** 通过「选择多个文件」选中且校验通过的文件。 */
  onFiles?: (files: File[]) => void;
  onMove?: (id: string, direction: 'down' | 'up') => void;
  onReject?: (rejections: UploadRejection[]) => void;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  pendingLabel: ReactNode;
  /** 排队中的状态文字（可选）。 */
  queuedLabel?: ReactNode;
  removeLabel: string;
  retryLabel: string;
  /** 「选择多个文件」按钮文字；不传则不显示按钮。 */
  selectLabel?: ReactNode;
  /** 标题模板，例如 `(count, max) => \`文件附件（${count}/${max}）\``。 */
  titleLabel: (count: number, max: number | undefined) => ReactNode;
};

const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

function defaultFormatSize(bytes: number, locale: string | undefined): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: unit === 0 ? 0 : 1,
      style: 'unit',
      unit: SIZE_UNITS[unit],
      unitDisplay: 'short',
    }).format(value);
  } catch {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  }
}

/**
 * 文件附件列表（规范 03 §3.29）：标题计数 + 「选择多个文件」、逐行「序号. 文件名 · 大小」、
 * 每行状态（待保存 / 上传中进度 / 失败 + 重试）、上移/下移、删除。条目由调用方受控，
 * 可配合 `useUploadQueue` 使用。
 */
export const FileList = forwardRef<HTMLDivElement, FileListProps>(function FileList(
  {
    accept,
    cancelLabel,
    className,
    disabled = false,
    doneLabel,
    failedLabel,
    footer,
    formatSize,
    items,
    locale,
    max,
    maxSize,
    moveDownLabel,
    moveUpLabel,
    onCancel,
    onFiles,
    onMove,
    onReject,
    onRemove,
    onRetry,
    pendingLabel,
    queuedLabel,
    removeLabel,
    retryLabel,
    selectLabel,
    titleLabel,
    ...props
  },
  ref,
) {
  const titleId = useId();
  const picker = useFilePicker({
    accept,
    currentCount: items.length,
    disabled,
    maxFiles: max,
    maxSize,
    multiple: true,
    onFiles,
    onReject,
  });
  const full = max !== undefined && items.length >= max;
  const format = (bytes: number) => formatSize?.(bytes) ?? defaultFormatSize(bytes, locale);

  return (
    <div
      aria-labelledby={titleId}
      className={cn('rx-file-list', className)}
      data-disabled={disabled ? 'true' : undefined}
      ref={ref}
      role="group"
      {...props}
    >
      <div className="rx-file-list-header">
        <span className="rx-file-list-title" id={titleId}>
          {titleLabel(items.length, max)}
        </span>
        {selectLabel === undefined ? null : (
          <>
            <input {...picker.inputProps} />
            <Button
              disabled={disabled || full}
              iconStart={<Files />}
              onClick={picker.open}
              size="sm"
              variant="outline"
            >
              {selectLabel}
            </Button>
          </>
        )}
      </div>
      {items.length === 0 ? null : (
        <ol className="rx-file-list-items">
          {items.map((item, index) => {
            const progress = Math.max(0, Math.min(100, item.progress ?? 0));
            const busy = item.status === 'uploading' || item.status === 'queued';
            let status: ReactNode = null;
            if (item.status === 'pending') status = pendingLabel;
            else if (item.status === 'failed') status = item.error ?? failedLabel;
            else if (item.status === 'done') status = doneLabel ?? null;
            else if (item.status === 'queued') status = queuedLabel ?? null;
            return (
              <li className="rx-file-list-row" data-state={item.status} key={item.id}>
                <span className="rx-file-list-main">
                  <span className="rx-file-list-index rx-numeric">{index + 1}.</span>
                  <span className="rx-file-list-name" title={item.name}>
                    {item.name}
                  </span>
                  <span aria-hidden="true" className="rx-file-list-separator">
                    ·
                  </span>
                  <span className="rx-file-list-size rx-numeric">{format(item.size)}</span>
                </span>
                {busy ? (
                  <span
                    aria-label={item.name}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={item.status === 'queued' ? undefined : Math.round(progress)}
                    className="rx-file-list-progress"
                    role="progressbar"
                  >
                    <span
                      className="rx-file-list-progress-bar"
                      style={{ transform: `scaleX(${progress / 100})` }}
                    />
                  </span>
                ) : null}
                {status === null ? null : (
                  <span
                    className="rx-file-list-status"
                    role={item.status === 'failed' ? 'alert' : undefined}
                  >
                    {status}
                  </span>
                )}
                <span className="rx-file-list-actions">
                  {item.status === 'failed' && onRetry ? (
                    <IconButton
                      disabled={disabled}
                      icon={<RotateCw />}
                      label={retryLabel}
                      onClick={() => onRetry(item.id)}
                      size="sm"
                    />
                  ) : null}
                  {onMove ? (
                    <>
                      <IconButton
                        disabled={disabled || index === 0}
                        icon={<ArrowUp />}
                        label={moveUpLabel}
                        onClick={() => onMove(item.id, 'up')}
                        size="sm"
                      />
                      <IconButton
                        disabled={disabled || index === items.length - 1}
                        icon={<ArrowDown />}
                        label={moveDownLabel}
                        onClick={() => onMove(item.id, 'down')}
                        size="sm"
                      />
                    </>
                  ) : null}
                  {busy && onCancel ? (
                    <IconButton
                      icon={<X />}
                      label={cancelLabel}
                      onClick={() => onCancel(item.id)}
                      size="sm"
                    />
                  ) : onRemove ? (
                    <IconButton
                      disabled={disabled}
                      icon={<Trash2 />}
                      label={removeLabel}
                      onClick={() => onRemove(item.id)}
                      size="sm"
                    />
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {footer === undefined ? null : <div className="rx-file-list-footer">{footer}</div>}
    </div>
  );
});
