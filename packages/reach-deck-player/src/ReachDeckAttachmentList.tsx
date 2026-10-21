'use client';

import { useState, type ReactNode } from 'react';
import type { QuizAttachmentReference } from '@reachany/reach-deck-dsl';
import { AttachmentCollection, type AttachmentDisposition } from '@reachany/ui';
import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';

function resourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, 'https://reach-deck.invalid');
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

export type ReachDeckAttachmentUrlResolver = (
  ref: { objectKey: string; assetId?: string; pageId?: string; questionId?: string },
  disposition: 'inline' | 'attachment',
) => Promise<{ url: string; disposition: 'inline' | 'attachment'; contentType?: string }>;

export type ReachDeckAttachmentUnavailablePredicate = (
  attachment: QuizAttachmentReference,
) => boolean;

export function ReachDeckAttachmentList({
  attachments,
  mediaUrlsByObjectKey = {},
  resolveAttachmentUrl,
  isAttachmentUnavailable,
  renderActions,
  translate,
  questionId,
}: {
  attachments: readonly QuizAttachmentReference[];
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  isAttachmentUnavailable?: ReachDeckAttachmentUnavailablePredicate;
  renderActions?: (attachment: QuizAttachmentReference, index: number) => ReactNode;
  translate?: ReachDeckTranslate;
  questionId?: string;
}) {
  const text = (key: string, fallback: string, params?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, params);
  const [error, setError] = useState('');
  const items = attachments.map((attachment) => {
    const unavailable =
      isAttachmentUnavailable?.(attachment) === true ||
      (!resolveAttachmentUrl && !resourceUrl(mediaUrlsByObjectKey[attachment.objectKey]));
    return {
      ...attachment,
      id: attachment.assetId ?? attachment.objectKey,
      unavailable,
      status: unavailable ? text('attachment.unavailable', '附件不可打开') : undefined,
    };
  });
  const resolveUrl = async (item: (typeof items)[number], disposition: AttachmentDisposition) => {
    setError('');
    if (!resolveAttachmentUrl) {
      const url = resourceUrl(mediaUrlsByObjectKey[item.objectKey]);
      if (!url) throw new Error('Attachment resolver unavailable');
      return { url, disposition: 'attachment' as const, contentType: item.contentType };
    }
    return resolveAttachmentUrl(
      { objectKey: item.objectKey, assetId: item.assetId, questionId },
      disposition,
    );
  };
  const actions = renderActions
    ? (item: (typeof items)[number]) => (
        <span className="reach-deck-attachment-edit-actions">
          {renderActions(
            item,
            items.findIndex((a) => a.id === item.id),
          )}
        </span>
      )
    : undefined;
  if (attachments.length === 0) return null;
  return (
    <div className="reach-deck-attachments">
      <AttachmentCollection
        items={items}
        allowDownload={Boolean(resolveAttachmentUrl)}
        resolveUrl={resolveUrl}
        onDownloadError={() => setError(text('attachment.downloadFailed', '下载失败，请重试。'))}
        renderActions={actions}
        labels={{
          preview: (name) => text('attachment.preview', '预览 {name}', { name }),
          download: (name) => text('attachment.download', '下载 {name}', { name }),
          dialog: {
            title: (name) => text('attachment.previewTitle', '附件预览：{name}', { name }),
            loading: text('attachment.loading', '正在加载…'),
            unsupported: text('attachment.previewUnsupported', '暂不支持在线预览'),
            failed: text('attachment.loadFailed', '加载失败，请重试。'),
            retry: text('attachment.retry', '重试'),
            previous: text('attachment.previous', '上一个'),
            next: text('attachment.next', '下一个'),
            download: text('attachment.downloadAction', '下载'),
            openInNewTab: text('attachment.openInNewTab', '在新标签页打开'),
            close: text('attachment.close', '关闭'),
          },
        }}
      />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
