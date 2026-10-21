'use client';

import { Download, Eye } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../cn';
import { attachmentIcon, attachmentPreviewKind } from './attachment-kind';
import { IconButton } from './IconButton';
import { Spinner } from './Spinner';

export interface AttachmentItem {
  id: string;
  name: string;
  sizeBytes?: number;
  contentType?: string;
  status?: ReactNode;
  unavailable?: boolean;
}

export interface AttachmentListProps<
  T extends AttachmentItem = AttachmentItem,
> extends HTMLAttributes<HTMLDivElement> {
  items: readonly T[];
  onPreview?: (item: T) => void;
  onDownload?: (item: T) => void;
  busyId?: string | null;
  busyIds?: readonly string[];
  renderActions?: (item: T) => ReactNode;
  ordered?: boolean;
  previewLabel: (name: string) => string;
  downloadLabel: (name: string) => string;
  emptyLabel?: ReactNode;
  formatSize?: (bytes: number) => string;
  locale?: string;
}

export function formatAttachmentSize(bytes: number, locale?: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[index],
    unitDisplay: 'short',
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(value);
}

/** 附件展示列表；编辑动作和所有可读文案由宿主传入。 */
export function AttachmentList<T extends AttachmentItem>({
  items,
  onPreview,
  onDownload,
  busyId,
  busyIds,
  renderActions,
  ordered = true,
  previewLabel,
  downloadLabel,
  emptyLabel,
  formatSize,
  locale,
  className,
  ...props
}: AttachmentListProps<T>) {
  return (
    <div className={cn('rx-file-list', 'rx-attachment-list', className)} {...props}>
      {items.length === 0 ? (
        emptyLabel
      ) : (
        <ol className="rx-file-list-items">
          {items.map((item, index) => {
            const kind = attachmentPreviewKind(item.contentType);
            const Icon = attachmentIcon(kind);
            const activate = item.unavailable
              ? undefined
              : kind === 'none'
                ? onDownload
                : (onPreview ?? onDownload);
            const busy = busyId === item.id || busyIds?.includes(item.id) === true;
            return (
              <li
                className="rx-file-list-row rx-attachment-row"
                key={item.id}
                aria-busy={busy || undefined}
              >
                <span className="rx-file-list-main">
                  {ordered ? (
                    <span className="rx-file-list-index rx-numeric">{index + 1}.</span>
                  ) : null}
                  <Icon aria-hidden="true" className="rx-attachment-icon" />
                  {activate ? (
                    <button
                      className="rx-file-list-name rx-attachment-name"
                      type="button"
                      aria-disabled={busy || undefined}
                      title={item.name}
                      onClick={() => {
                        if (!busy) activate(item);
                      }}
                    >
                      {item.name}
                    </button>
                  ) : (
                    <span className="rx-file-list-name" title={item.name}>
                      {item.name}
                    </span>
                  )}
                  {item.sizeBytes === undefined ? null : (
                    <span className="rx-file-list-size rx-numeric">
                      {formatSize?.(item.sizeBytes) ?? formatAttachmentSize(item.sizeBytes, locale)}
                    </span>
                  )}
                </span>
                {item.status === undefined ? null : (
                  <span className="rx-file-list-status">{item.status}</span>
                )}
                <span className="rx-file-list-actions">
                  {onPreview && !item.unavailable ? (
                    <IconButton
                      aria-disabled={busy || undefined}
                      icon={<Eye />}
                      label={previewLabel(item.name)}
                      onClick={() => {
                        if (!busy) onPreview(item);
                      }}
                      size="sm"
                    />
                  ) : null}
                  {onDownload && !item.unavailable ? (
                    <IconButton
                      aria-disabled={busy || undefined}
                      aria-busy={busy || undefined}
                      data-loading={busy ? 'true' : undefined}
                      icon={busy ? <Spinner size="sm" /> : <Download />}
                      label={downloadLabel(item.name)}
                      onClick={() => {
                        if (!busy) onDownload(item);
                      }}
                      size="sm"
                    />
                  ) : null}
                  {renderActions?.(item)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
