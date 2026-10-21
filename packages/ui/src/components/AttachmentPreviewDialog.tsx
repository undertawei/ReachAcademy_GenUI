'use client';

import { ChevronLeft, ChevronRight, Download, ExternalLink, RotateCw } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';

import { formatAttachmentSize, type AttachmentItem } from './AttachmentList';
import { attachmentIcon, type AttachmentPreviewKind } from './attachment-kind';
import { Button, buttonStyleProps } from './Button';
import { Dialog } from './Dialog';
import { IconButton } from './IconButton';
import { Spinner } from './Spinner';
import type { AttachmentDisposition } from './useAttachmentPreview';

export type AttachmentPreviewStatus = 'loading' | 'content' | 'unsupported' | 'failed';

export interface AttachmentPreviewLabels {
  title: (name: string) => string;
  loading: string;
  unsupported: string;
  failed: string;
  retry: string;
  previous: string;
  next: string;
  download: string;
  openInNewTab: string;
  close: string;
}

export interface AttachmentPreviewDialogProps {
  open: boolean;
  item: AttachmentItem | null;
  status: AttachmentPreviewStatus;
  kind: AttachmentPreviewKind;
  url?: string;
  disposition?: AttachmentDisposition;
  labels: AttachmentPreviewLabels;
  locale?: string;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onMediaError: (errorCode?: number) => void;
  onMediaLoad?: () => void;
  onDownload?: () => void;
  downloadBusy?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
}

/** 共享 Dialog 提供 Esc、焦点陷阱和焦点归还；附件切换不重建弹窗。 */
export function AttachmentPreviewDialog({
  open,
  item,
  status,
  kind,
  url,
  disposition,
  labels,
  locale,
  onOpenChange,
  onRetry,
  onMediaError,
  onMediaLoad,
  onDownload,
  downloadBusy,
  onPrevious,
  onNext,
}: AttachmentPreviewDialogProps) {
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const navigationFocus = useRef<'previous' | 'next' | null>(null);
  useLayoutEffect(() => {
    const direction = navigationFocus.current;
    if (!direction) return;
    const preferred = direction === 'next' ? nextRef.current : previousRef.current;
    const fallback = direction === 'next' ? previousRef.current : nextRef.current;
    if (preferred && !preferred.disabled) preferred.focus();
    else if (fallback && !fallback.disabled) fallback.focus();
    navigationFocus.current = null;
  }, [item?.id, onPrevious, onNext]);
  const navigate = (direction: 'previous' | 'next', action?: () => void) => {
    if (!action) return;
    navigationFocus.current = direction;
    action();
  };
  if (!item) return null;
  const Icon = attachmentIcon(kind);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={labels.title(item.name)}
      closeLabel={labels.close}
      className="rx-attachment-preview-dialog"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          target.closest('input,textarea,video,audio,[contenteditable="true"]') ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        const direction =
          event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next' : undefined;
        const action =
          direction === 'previous' ? onPrevious : direction === 'next' ? onNext : undefined;
        if (direction && action) {
          event.preventDefault();
          navigate(direction, action);
        }
      }}
      footer={
        <>
          {onPrevious || onNext ? (
            <span className="rx-attachment-navigation">
              <IconButton
                disabled={!onPrevious}
                ref={previousRef}
                size="sm"
                icon={<ChevronLeft />}
                label={labels.previous}
                onClick={() => navigate('previous', onPrevious)}
              />
              <IconButton
                disabled={!onNext}
                ref={nextRef}
                size="sm"
                icon={<ChevronRight />}
                label={labels.next}
                onClick={() => navigate('next', onNext)}
              />
            </span>
          ) : null}
          {onDownload ? (
            <Button
              iconStart={downloadBusy ? <Spinner size="sm" /> : <Download />}
              aria-disabled={downloadBusy || undefined}
              aria-busy={downloadBusy || undefined}
              data-loading={downloadBusy ? 'true' : undefined}
              onClick={() => {
                if (!downloadBusy) onDownload();
              }}
            >
              {labels.download}
            </Button>
          ) : null}
          {url && disposition === 'inline' && status === 'content' ? (
            <a
              {...buttonStyleProps({ variant: 'outline' })}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="rx-button-content">
                <span className="rx-button-icon" aria-hidden="true">
                  <ExternalLink />
                </span>
                <span className="rx-button-label">{labels.openInNewTab}</span>
              </span>
            </a>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>{labels.close}</Button>
        </>
      }
    >
      <div className="rx-attachment-preview" data-state={status}>
        {status === 'loading' ? (
          <div className="rx-attachment-preview-state" role="status">
            <Spinner />
            <span>{labels.loading}</span>
          </div>
        ) : null}
        {status === 'failed' ? (
          <div className="rx-attachment-preview-state" role="alert">
            <span>{labels.failed}</span>
            <Button iconStart={<RotateCw />} onClick={onRetry}>
              {labels.retry}
            </Button>
          </div>
        ) : null}
        {status === 'unsupported' ? (
          <div className="rx-attachment-preview-state">
            <Icon aria-hidden="true" />
            <span className="rx-attachment-preview-filename">{item.name}</span>
            {item.sizeBytes === undefined ? null : (
              <span>{formatAttachmentSize(item.sizeBytes, locale)}</span>
            )}
            <span>{labels.unsupported}</span>
          </div>
        ) : null}
        {status === 'content' && url ? (
          kind === 'image' ? (
            <img
              key={url}
              className="rx-attachment-preview-media"
              src={url}
              alt={item.name}
              onError={() => onMediaError()}
              onLoad={onMediaLoad}
            />
          ) : kind === 'video' ? (
            <video
              key={url}
              className="rx-attachment-preview-media"
              src={url}
              controls
              onError={(event) => onMediaError(event.currentTarget.error?.code)}
              onLoadedData={onMediaLoad}
              aria-label={item.name}
            />
          ) : kind === 'audio' ? (
            <audio
              key={url}
              src={url}
              controls
              onError={(event) => onMediaError(event.currentTarget.error?.code)}
              onLoadedData={onMediaLoad}
              aria-label={item.name}
            />
          ) : kind === 'pdf' ? (
            // 跨域 iframe 的 HTTP 403 不触发可靠 onError；过期后需手动重新打开换签。
            <iframe
              key={url}
              className="rx-attachment-preview-media"
              src={url}
              title={item.name}
              onError={() => onMediaError()}
            />
          ) : kind === 'text' ? (
            <iframe
              key={url}
              className="rx-attachment-preview-media"
              src={url}
              title={item.name}
              sandbox=""
              onError={() => onMediaError()}
            />
          ) : null
        ) : null}
      </div>
    </Dialog>
  );
}
