'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileListItemStatus } from './FileList';

export interface UploadContext {
  /** 取消（用户点取消/移除、组件卸载）时触发；上传实现应把它传给 fetch/XHR。 */
  signal: AbortSignal;
  /** 上报进度，0–100。 */
  onProgress: (percent: number) => void;
}

export type UploadQueueStatus = Extract<
  FileListItemStatus,
  'failed' | 'pending' | 'queued' | 'uploading'
>;

export interface UploadQueueItem<R = unknown> {
  error?: unknown;
  file: File;
  id: string;
  name: string;
  progress: number;
  /** 上传成功后 `upload()` 的返回值。 */
  result?: R;
  size: number;
  /** queued 排队 → uploading 上传中 → pending 已上传待保存 / failed 失败（可重试）。 */
  status: UploadQueueStatus;
}

export interface UseUploadQueueOptions<R> {
  /** 同时上传的最大数量，默认 3（规范 03 §3.29）。 */
  concurrency?: number;
  onError?: (item: UploadQueueItem<R>, error: unknown) => void;
  onSuccess?: (item: UploadQueueItem<R>, result: R) => void;
  upload: (file: File, context: UploadContext) => Promise<R>;
}

export interface UploadQueue<R> {
  add: (files: readonly File[]) => string[];
  /** 取消上传中/排队的文件并从队列移除（已上传的文件同样移除）。 */
  cancel: (id: string) => void;
  clear: () => void;
  items: UploadQueueItem<R>[];
  move: (id: string, direction: 'down' | 'up') => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
}

let sequence = 0;

/**
 * 并发受限的上传队列（默认最多 3 个同时上传），支持取消与失败重试。
 * `items` 可直接交给 `<FileList items={queue.items} />`。
 */
export function useUploadQueue<R = unknown>({
  concurrency = 3,
  onError,
  onSuccess,
  upload,
}: UseUploadQueueOptions<R>): UploadQueue<R> {
  const [items, setItems] = useState<UploadQueueItem<R>[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const callbacks = useRef({ onError, onSuccess, upload });
  callbacks.current = { onError, onSuccess, upload };

  const patch = useCallback((id: string, next: Partial<UploadQueueItem<R>>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const start = useCallback(
    (item: UploadQueueItem<R>) => {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      patch(item.id, { error: undefined, progress: 0, status: 'uploading' });
      const { signal } = controller;
      const settle = () => {
        if (controllers.current.get(item.id) === controller) controllers.current.delete(item.id);
      };
      let promise: Promise<R>;
      try {
        promise = Promise.resolve(
          callbacks.current.upload(item.file, {
            onProgress: (percent) => {
              if (signal.aborted) return;
              const progress = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
              patch(item.id, { progress });
            },
            signal,
          }),
        );
      } catch (error) {
        promise = Promise.reject(error);
      }
      promise.then(
        (result) => {
          if (signal.aborted) return;
          settle();
          patch(item.id, { progress: 100, result, status: 'pending' });
          callbacks.current.onSuccess?.(
            { ...item, progress: 100, result, status: 'pending' },
            result,
          );
        },
        (error: unknown) => {
          if (signal.aborted) return;
          settle();
          patch(item.id, { error, status: 'failed' });
          callbacks.current.onError?.({ ...item, error, status: 'failed' }, error);
        },
      );
    },
    [patch],
  );

  // 有空位就启动排队中的文件。
  useEffect(() => {
    const slots = Math.max(1, concurrency) - controllers.current.size;
    if (slots <= 0) return;
    items
      .filter((item) => item.status === 'queued' && !controllers.current.has(item.id))
      .slice(0, slots)
      .forEach(start);
  }, [concurrency, items, start]);

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  const add = useCallback((files: readonly File[]) => {
    const added = files.map<UploadQueueItem<R>>((file) => {
      sequence += 1;
      return {
        file,
        id: `rx-upload-${sequence}`,
        name: file.name,
        progress: 0,
        size: file.size,
        status: 'queued',
      };
    });
    if (added.length > 0) setItems((current) => [...current, ...added]);
    return added.map((item) => item.id);
  }, []);

  const remove = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    if (controller) {
      controllers.current.delete(id);
      controller.abort();
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const retry = useCallback((id: string) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id && item.status === 'failed'
          ? { ...item, error: undefined, progress: 0, status: 'queued' }
          : item,
      ),
    );
  }, []);

  const move = useCallback((id: string, direction: 'down' | 'up') => {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      const target = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    setItems([]);
  }, []);

  return { add, cancel: remove, clear, items, move, remove, retry };
}
