'use client';

import type { ReactNode } from 'react';

import { AttachmentList } from './AttachmentList';
import { AttachmentPreviewDialog, type AttachmentPreviewLabels } from './AttachmentPreviewDialog';
import {
  useAttachmentPreview,
  type AttachmentDisposition,
  type AttachmentUrl,
} from './useAttachmentPreview';

export interface AttachmentReference {
  assetId?: string;
  objectKey?: string;
  id?: string;
  name: string;
  contentType?: string;
  sizeBytes?: number;
  status?: ReactNode;
  unavailable?: boolean;
}

export interface AttachmentCollectionLabels {
  preview: (name: string) => string;
  download: (name: string) => string;
  dialog: AttachmentPreviewLabels;
}

export interface AttachmentCollectionProps<T extends AttachmentReference> {
  items: readonly T[];
  resolveUrl: (
    item: T,
    disposition: AttachmentDisposition,
    signal?: AbortSignal,
  ) => Promise<AttachmentUrl>;
  renderActions?: (item: T) => ReactNode;
  ordered?: boolean;
  locale?: string;
  labels: AttachmentCollectionLabels;
  onDownloadError?: (error: unknown, item: T) => void;
  allowDownload?: boolean;
  allowedBlobUrls?: ReadonlySet<string>;
}

/** 共享附件流程只接收宿主文案与签名器，不依赖应用或通知 Provider。 */
export function AttachmentCollection<T extends AttachmentReference>({
  items,
  resolveUrl,
  renderActions,
  ordered = true,
  locale,
  labels,
  onDownloadError,
  allowDownload = true,
  allowedBlobUrls,
}: AttachmentCollectionProps<T>) {
  const references = items.map((item) => ({
    ...item,
    id: item.id ?? item.assetId ?? item.objectKey ?? item.name,
  }));
  const preview = useAttachmentPreview({
    items: references.filter((item) => !item.unavailable),
    resolveUrl,
    allowedBlobUrls,
    onError: (error, item) => onDownloadError?.(error, item),
  });
  if (items.length === 0) return null;
  return (
    <>
      <AttachmentList
        items={references}
        onPreview={preview.preview}
        onDownload={allowDownload ? preview.download : undefined}
        busyIds={preview.busyIds}
        ordered={ordered}
        locale={locale}
        renderActions={renderActions}
        previewLabel={labels.preview}
        downloadLabel={labels.download}
      />
      <AttachmentPreviewDialog
        {...preview.dialogProps}
        onDownload={allowDownload ? preview.dialogProps.onDownload : undefined}
        labels={labels.dialog}
        locale={locale}
      />
    </>
  );
}

/** 将业务签名响应转换为共享类型；同步发布要求实际展示方式始终存在。 */
export function attachmentUrl(result: {
  downloadUrl: string;
  disposition?: AttachmentDisposition | null;
  contentType?: string | null;
}): AttachmentUrl {
  if (result.disposition !== 'inline' && result.disposition !== 'attachment')
    throw new Error('Attachment presentation is unavailable');
  return {
    url: result.downloadUrl,
    disposition: result.disposition,
    contentType: result.contentType ?? undefined,
  };
}
