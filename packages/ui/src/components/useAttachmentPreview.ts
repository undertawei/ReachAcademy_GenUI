'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AttachmentItem } from './AttachmentList';
import type {
  AttachmentPreviewDialogProps,
  AttachmentPreviewStatus,
} from './AttachmentPreviewDialog';
import { attachmentPreviewKind, type AttachmentPreviewKind } from './attachment-kind';

export type AttachmentDisposition = 'inline' | 'attachment';
export interface AttachmentUrl {
  url: string;
  disposition: AttachmentDisposition;
  contentType?: string;
}

export interface UseAttachmentPreviewOptions<T extends AttachmentItem> {
  items: readonly T[];
  resolveUrl: (
    item: T,
    disposition: AttachmentDisposition,
    signal?: AbortSignal,
  ) => Promise<AttachmentUrl>;
  onError?: (error: unknown, item: T, operation: 'preview' | 'download') => void;
  /** Host-created pending uploads only; never populate this set from stored asset metadata. */
  allowedBlobUrls?: ReadonlySet<string>;
}

interface PreviewState<T extends AttachmentItem> {
  item: T | null;
  open: boolean;
  status: AttachmentPreviewStatus;
  kind: AttachmentPreviewKind;
  url?: string;
  disposition?: AttachmentDisposition;
}

/** 只允许网络 URL 进入媒体或链接元素，避免不可信资产元数据成为可执行协议。 */
function validatedUrl(url: string, allowedBlobUrls?: ReadonlySet<string>): string {
  const parsed = new URL(url, window.location.href);
  if (
    parsed.protocol === 'blob:' &&
    parsed.origin !== 'null' &&
    parsed.origin === window.location.origin &&
    allowedBlobUrls?.has(url)
  )
    return parsed.href;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('Invalid attachment URL');
  return parsed.href;
}

export function useAttachmentPreview<T extends AttachmentItem>(
  options: UseAttachmentPreviewOptions<T>,
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mounted = useRef(true);
  const requestId = useRef(0);
  const downloadId = useRef(0);
  const pendingDownloads = useRef(new Map<string, number>());
  const current = useRef<T | null>(null);
  const resigned = useRef(false);
  const previewController = useRef<AbortController | null>(null);
  const downloadControllers = useRef(new Map<number, AbortController>());
  const [state, setState] = useState<PreviewState<T>>({
    item: null,
    open: false,
    status: 'loading',
    kind: 'none',
  });
  const [busyIds, setBusyIds] = useState<readonly string[]>([]);
  const busyId = busyIds[busyIds.length - 1] ?? null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
      downloadId.current += 1;
      pendingDownloads.current.clear();
      previewController.current?.abort();
      downloadControllers.current.forEach((controller) => controller.abort());
      downloadControllers.current.clear();
    };
  }, []);

  const close = useCallback(() => {
    current.current = null;
    requestId.current += 1;
    previewController.current?.abort();
    setState((previous) => ({ ...previous, open: false, url: undefined }));
  }, []);

  const resolvePreview = useCallback(async (item: T) => {
    const id = ++requestId.current;
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    current.current = item;
    setState({
      item,
      open: true,
      status: 'loading',
      kind: attachmentPreviewKind(item.contentType),
    });
    try {
      const resolved = await timedAttachmentUrl(controller, () =>
        optionsRef.current.resolveUrl(item, 'inline', controller.signal),
      );
      if (!mounted.current || requestId.current !== id) return;
      const url = validatedUrl(resolved.url, optionsRef.current.allowedBlobUrls);
      const kind = attachmentPreviewKind(resolved.contentType ?? item.contentType);
      // 媒体子资源不受下载响应头限制；文档只接受服务端明确签发的 inline。
      const supported =
        kind !== 'none' &&
        (resolved.disposition === 'inline' ||
          kind === 'image' ||
          kind === 'audio' ||
          kind === 'video');
      setState({
        item: { ...item, contentType: resolved.contentType ?? item.contentType },
        open: true,
        status: supported ? 'content' : 'unsupported',
        kind,
        url,
        disposition: resolved.disposition,
      });
    } catch (error) {
      if (!mounted.current || requestId.current !== id) return;
      setState({
        item,
        open: true,
        status: 'failed',
        kind: attachmentPreviewKind(item.contentType),
      });
    }
  }, []);

  const preview = useCallback(
    (item: T) => {
      resigned.current = false;
      return resolvePreview(item);
    },
    [resolvePreview],
  );

  const download = useCallback(async (item: T) => {
    if (pendingDownloads.current.has(item.id)) return;
    const id = ++downloadId.current;
    const controller = new AbortController();
    downloadControllers.current.set(id, controller);
    pendingDownloads.current.set(item.id, id);
    setBusyIds([...pendingDownloads.current.keys()]);
    try {
      const resolved = await timedAttachmentUrl(controller, () =>
        optionsRef.current.resolveUrl(item, 'attachment', controller.signal),
      );
      if (!mounted.current || pendingDownloads.current.get(item.id) !== id) return;
      if (resolved.disposition !== 'attachment')
        throw new Error('Attachment download requires attachment disposition');
      const anchor = document.createElement('a');
      anchor.href = validatedUrl(resolved.url, optionsRef.current.allowedBlobUrls);
      anchor.download = item.name;
      // 跨域下载以服务端 Content-Disposition 文件名为准，该属性仅作为同源兜底。
      anchor.rel = 'noopener noreferrer';
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    } catch (error) {
      if (mounted.current && pendingDownloads.current.get(item.id) === id)
        optionsRef.current.onError?.(error, item, 'download');
    } finally {
      downloadControllers.current.delete(id);
      if (mounted.current && pendingDownloads.current.get(item.id) === id) {
        pendingDownloads.current.delete(item.id);
        setBusyIds([...pendingDownloads.current.keys()]);
      }
    }
  }, []);

  const mediaRequestId = requestId.current;
  const onMediaLoad = useCallback(() => {
    if (mounted.current && requestId.current === mediaRequestId && state.status === 'content') {
      resigned.current = false;
    }
  }, [mediaRequestId, state.status]);
  const onMediaError = useCallback(
    (errorCode?: number) => {
      const item = current.current;
      if (!item || requestId.current !== mediaRequestId || state.status !== 'content') return;
      // 元数据加载前的过期响应也可能报 SRC_NOT_SUPPORTED (4)，与网络错误同样先换签一次。
      if (
        (state.kind === 'audio' || state.kind === 'video') &&
        errorCode !== 2 &&
        errorCode !== 4
      ) {
        const unsupported =
          errorCode === undefined &&
          state.kind === 'video' &&
          state.item?.contentType?.split(';')[0]?.trim().toLowerCase() === 'video/quicktime';
        requestId.current += 1;
        setState((previous) => ({
          ...previous,
          status: unsupported ? 'unsupported' : 'failed',
          url: undefined,
        }));
        return;
      }
      if (!resigned.current) {
        resigned.current = true;
        void resolvePreview(item);
      } else {
        requestId.current += 1;
        setState((previous) => ({
          ...previous,
          status: errorCode === 4 ? 'unsupported' : 'failed',
          url: undefined,
        }));
      }
    },
    [resolvePreview, mediaRequestId, state.status, state.kind, state.item],
  );

  useEffect(() => {
    if (current.current && !options.items.some((item) => item.id === current.current?.id)) close();
  }, [options.items, close]);

  const index = state.item ? options.items.findIndex((item) => item.id === state.item?.id) : -1;
  const dialogProps: Omit<AttachmentPreviewDialogProps, 'labels'> = {
    ...state,
    onOpenChange: (open) => {
      if (!open) close();
    },
    onRetry: () => {
      if (current.current) void preview(current.current);
    },
    onMediaError,
    onMediaLoad,
    onDownload: () => {
      if (current.current) void download(current.current);
    },
    downloadBusy: state.item !== null && busyIds.includes(state.item.id),
    onPrevious:
      index > 0
        ? () => {
            const item = optionsRef.current.items[index - 1];
            if (item) void preview(item);
          }
        : undefined,
    onNext:
      index >= 0 && index < options.items.length - 1
        ? () => {
            const item = optionsRef.current.items[index + 1];
            if (item) void preview(item);
          }
        : undefined,
  };

  return { preview, download, busyId, busyIds, dialogProps };
}

/** Timeout and cancellation also settle hosts whose resolver ignores AbortSignal. */
async function timedAttachmentUrl(
  controller: AbortController,
  resolve: () => Promise<AttachmentUrl>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      resolve(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException('Attachment request aborted', 'AbortError'));
        if (controller.signal.aborted) {
          abort();
          return;
        }
        controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) controller.signal.removeEventListener('abort', abort);
  }
}
