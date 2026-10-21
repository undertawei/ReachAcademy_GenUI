// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentList, type AttachmentItem } from './AttachmentList';
import { AttachmentCollection } from './AttachmentCollection';
import { AttachmentPreviewDialog, type AttachmentPreviewLabels } from './AttachmentPreviewDialog';
import { attachmentPreviewKind } from './attachment-kind';
import {
  useAttachmentPreview,
  type AttachmentUrl,
  type UseAttachmentPreviewOptions,
} from './useAttachmentPreview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const items: AttachmentItem[] = [
  { id: 'one', name: '课件.png', contentType: 'image/png', sizeBytes: 1024 },
  { id: 'two', name: 'notes.pdf', contentType: 'application/pdf' },
  {
    id: 'office',
    name: 'table.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 2048,
  },
];
const labels: AttachmentPreviewLabels = {
  title: (name) => `Preview ${name}`,
  loading: 'Loading',
  unsupported: 'Preview unavailable',
  failed: 'Could not load',
  retry: 'Retry',
  previous: 'Previous',
  next: 'Next',
  download: 'Download',
  openInNewTab: 'Open in new tab',
  close: 'Close',
};
const chineseLabels: AttachmentPreviewLabels = {
  title: (name) => `预览 ${name}`,
  loading: '加载中',
  unsupported: '暂不支持预览',
  failed: '加载失败',
  retry: '重试',
  previous: '上一个',
  next: '下一个',
  download: '下载',
  openInNewTab: '在新标签页打开',
  close: '关闭',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function signed(
  disposition: 'inline' | 'attachment' = 'inline',
  url = 'https://media.test/file',
): AttachmentUrl {
  return { disposition, url };
}

describe('attachment preview MIME safety', () => {
  it('uses the exact allowed media MIME types and never authorizes preview by extension', () => {
    expect(attachmentPreviewKind(' IMAGE/PNG ; charset=utf-8')).toBe('image');
    expect(attachmentPreviewKind('image/gif')).toBe('image');
    expect(attachmentPreviewKind('application/pdf')).toBe('pdf');
    expect(attachmentPreviewKind('video/quicktime')).toBe('video');
    expect(attachmentPreviewKind('audio/x-m4a')).toBe('audio');
    expect(attachmentPreviewKind('text/markdown')).toBe('text');
    for (const mime of [
      'image/svg+xml',
      'image/bmp',
      'video/ogg',
      'audio/midi',
      'text/html',
      'application/xhtml+xml',
      'application/json',
      'text/',
      undefined,
    ]) {
      expect(attachmentPreviewKind(mime)).toBe('none');
    }
  });
});

describe('Attachment interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: ReturnType<typeof useAttachmentPreview<AttachmentItem>>;

  function Harness({
    options,
    translated = labels,
  }: {
    options: UseAttachmentPreviewOptions<AttachmentItem>;
    translated?: AttachmentPreviewLabels;
  }) {
    controller = useAttachmentPreview(options);
    return <AttachmentPreviewDialog {...controller.dialogProps} labels={translated} />;
  }

  function render(options: UseAttachmentPreviewOptions<AttachmentItem>, translated = labels) {
    act(() => root.render(<Harness options={options} translated={translated} />));
  }

  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.getAttribute('aria-label') === label || element.textContent === label,
    )!;
  }

  function key(element: Element, value: string, shiftKey = false) {
    act(() =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }),
      ),
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.querySelector('[data-rx-portal-root]')?.replaceChildren();
    document.head.querySelector('[data-attachment-style-test]')?.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['default', 'allowed', 'foreign', 'null'] as const)(
    'accepts only explicitly allowed same-origin pending blob previews and downloads: %s',
    async (mode) => {
      const url = `blob:${mode === 'foreign' ? 'https://foreign.test' : mode === 'null' ? 'null' : window.location.origin}/pending-image`;
      const onError = vi.fn();
      render({
        items,
        resolveUrl: async (_item, disposition) => signed(disposition, url),
        onError,
        ...(mode === 'default' ? {} : { allowedBlobUrls: new Set([url]) }),
      });
      const download = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);
      await act(async () => controller.preview(items[0]!));
      if (mode === 'allowed')
        expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(url);
      else
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Could not load');
      await act(async () => controller.download(items[0]!));
      if (mode === 'allowed') expect(download).toHaveBeenCalledOnce();
      else {
        expect(download).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalled();
      }
    },
  );

  it('closes an attachment preview when its reference becomes unavailable', async () => {
    const resolveUrl = vi.fn(async () => signed());
    const renderCollection = (unavailable: boolean) =>
      root.render(
        <AttachmentCollection
          items={[{ ...items[0]!, unavailable }]}
          resolveUrl={resolveUrl}
          labels={{
            preview: (name) => `Preview ${name}`,
            download: (name) => `Download ${name}`,
            dialog: labels,
          }}
        />,
      );
    act(() => renderCollection(false));
    await act(async () => button('Preview 课件.png').click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => renderCollection(true));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(resolveUrl).toHaveBeenCalledOnce();
  });

  it('renders caller labels, uses filename activation by kind, exposes extra editing actions and busy state', () => {
    const preview = vi.fn();
    const download = vi.fn();
    act(() =>
      root.render(
        <AttachmentList
          items={items}
          onPreview={preview}
          onDownload={download}
          previewLabel={(name) => `Preview ${name}`}
          downloadLabel={(name) => `Download ${name}`}
          renderActions={(item) => <button type="button">Remove {item.name}</button>}
          locale="en-US"
        />,
      ),
    );
    const names = container.querySelectorAll<HTMLButtonElement>('.rx-attachment-name');
    act(() => names[0]!.click());
    act(() => names[2]!.click());
    expect(preview).toHaveBeenCalledWith(items[0]);
    expect(download).toHaveBeenCalledWith(items[2]);
    expect(button('Preview table.xlsx')).toBeTruthy();
    expect(button('Download 课件.png')).toBeTruthy();
    expect(container.textContent).toContain('1 kB');
    expect(container.textContent).toContain('Remove notes.pdf');
    act(() =>
      root.render(
        <AttachmentList
          items={items}
          busyId="one"
          previewLabel={(name) => name}
          downloadLabel={(name) => name}
          onDownload={download}
        />,
      ),
    );
    expect(container.querySelector('.rx-file-list-row')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('.rx-attachment-name')?.disabled).toBe(false);
    expect(container.querySelector('.rx-attachment-name')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    act(() =>
      root.render(
        <AttachmentList
          items={[]}
          emptyLabel="暂无附件"
          previewLabel={(name) => name}
          downloadLabel={(name) => name}
        />,
      ),
    );
    expect(container.textContent).toBe('暂无附件');
  });

  it('opens loading synchronously and preserves aria, keyboard navigation, focus trapping and Esc', async () => {
    const pending = deferred<AttachmentUrl>();
    const resolveUrl = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(signed());
    render({ items, resolveUrl });
    act(() => {
      void controller.preview(items[0]!);
    });
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading');
    await act(async () => {
      pending.resolve(signed());
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Preview 课件.png',
    );
    expect(document.querySelector('img')?.alt).toBe('课件.png');
    await act(async () => key(dialog, 'ArrowRight'));
    expect(document.querySelector('iframe')?.title).toBe('notes.pdf');
    await act(async () => key(dialog, 'ArrowLeft'));
    expect(document.querySelector('img')?.alt).toBe('课件.png');
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')];
    act(() => focusable[focusable.length - 1]!.focus());
    key(document.activeElement!, 'Tab');
    expect(document.activeElement).toBe(focusable[0]);
    key(document.activeElement!, 'Tab', true);
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    key(dialog, 'Escape');
    expect(controller.dialogProps.open).toBe(false);
  });

  it('keeps download and filename buttons focusable while blocking repeated activation', () => {
    const download = vi.fn();
    const renderList = (busyIds: string[]) =>
      act(() =>
        root.render(
          <AttachmentList
            items={[items[2]!]}
            busyIds={busyIds}
            onDownload={download}
            previewLabel={(name) => `Preview ${name}`}
            downloadLabel={(name) => `Download ${name}`}
          />,
        ),
      );
    renderList([]);
    const filename = container.querySelector<HTMLButtonElement>('.rx-attachment-name')!;
    act(() => filename.focus());
    act(() => filename.click());
    renderList(['office']);
    expect(document.activeElement).toBe(filename);
    expect(filename.disabled).toBe(false);
    expect(filename.getAttribute('aria-disabled')).toBe('true');
    act(() => filename.click());
    expect(download).toHaveBeenCalledTimes(1);
    const action = button('Download table.xlsx');
    act(() => action.focus());
    renderList(['office']);
    expect(document.activeElement).toBe(action);
    expect(action.disabled).toBe(false);
    expect(action.getAttribute('aria-busy')).toBe('true');
    act(() => action.click());
    expect(download).toHaveBeenCalledTimes(1);
    renderList([]);
    act(() => action.click());
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('gives a busy preview tool disabled styling without removing keyboard focus', () => {
    const style = document.createElement('style');
    style.dataset.attachmentStyleTest = 'true';
    style.textContent = readFileSync('src/styles/button.css', 'utf8');
    document.head.append(style);
    const preview = vi.fn();
    act(() =>
      root.render(
        <AttachmentList
          items={[items[0]!]}
          busyIds={['one']}
          onPreview={preview}
          previewLabel={(name) => `Preview ${name}`}
          downloadLabel={(name) => `Download ${name}`}
        />,
      ),
    );
    const action = button('Preview 课件.png');
    expect(action.disabled).toBe(false);
    expect(getComputedStyle(action).opacity).toBe('0.45');
    expect(getComputedStyle(action).cursor).toBe('not-allowed');
    act(() => action.focus());
    act(() => action.click());
    expect(document.activeElement).toBe(action);
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps the dialog download focused and traps focus while a download is pending', async () => {
    const pending = deferred<AttachmentUrl>();
    const resolveUrl = vi.fn().mockResolvedValueOnce(signed()).mockReturnValueOnce(pending.promise);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render({ items: [items[0]!], resolveUrl });
    await act(async () => controller.preview(items[0]!));
    const action = button('Download');
    act(() => action.focus());
    act(() => action.click());
    expect(action.disabled).toBe(false);
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.querySelector('.rx-spinner')).not.toBeNull();
    expect(document.activeElement).toBe(action);
    act(() => action.click());
    expect(resolveUrl).toHaveBeenCalledTimes(2);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')];
    act(() => focusable[focusable.length - 1]!.focus());
    act(() => key(dialog, 'Tab'));
    expect(document.activeElement).toBe(focusable[0]);
    act(() => key(dialog, 'Tab', true));
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    act(() => action.focus());
    await act(async () => pending.resolve(signed('attachment')));
    expect(document.activeElement).toBe(action);
    expect(action.getAttribute('aria-busy')).toBeNull();
  });

  it('times out an ignored preview signal, permits retry and rejects the late old URL', async () => {
    vi.useFakeTimers();
    const pending = deferred<AttachmentUrl>();
    let signal: AbortSignal | undefined;
    const resolveUrl = vi
      .fn((_item: AttachmentItem, _disposition: string, requested?: AbortSignal) => {
        signal = requested;
        return pending.promise;
      })
      .mockImplementationOnce((_item, _disposition, requested) => {
        signal = requested;
        return pending.promise;
      });
    render({ items, resolveUrl });
    let opening!: Promise<void>;
    act(() => {
      opening = controller.preview(items[0]!);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await opening;
    });
    expect(signal?.aborted).toBe(true);
    expect(document.body.textContent).toContain('Could not load');
    resolveUrl.mockResolvedValue(signed('inline', 'https://media.test/retried'));
    await act(async () => button('Retry').click());
    expect(document.querySelector('img.rx-attachment-preview-media')?.getAttribute('src')).toBe(
      'https://media.test/retried',
    );
    await act(async () => pending.resolve(signed('inline', 'https://media.test/stale')));
    expect(document.querySelector('img.rx-attachment-preview-media')?.getAttribute('src')).toBe(
      'https://media.test/retried',
    );
  });

  it('aborts a previous preview on navigation even when its resolver ignores cancellation', async () => {
    const pending = deferred<AttachmentUrl>();
    const signals: AbortSignal[] = [];
    const resolveUrl = vi
      .fn((_item: AttachmentItem, _disposition: string, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return pending.promise;
      })
      .mockResolvedValueOnce(signed());
    render({ items, resolveUrl });
    await act(async () => controller.preview(items[0]!));
    let opening!: Promise<void>;
    act(() => {
      opening = controller.preview(items[1]!);
    });
    act(() => controller.dialogProps.onOpenChange(false));
    await act(async () => opening);
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => pending.resolve(signed()));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('releases download busy state after timeout and reports the failed operation', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const resolveUrl = vi.fn(() => new Promise<AttachmentUrl>(() => {}));
    render({ items, resolveUrl, onError });
    let downloading!: Promise<void>;
    act(() => {
      downloading = controller.download(items[0]!);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await downloading;
    });
    expect(controller.busyIds).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
      items[0],
      'download',
    );
  });

  it.each(['audio', 'video'])(
    'does not resign %s decoding, aborted or unknown errors after a successful load',
    async (tag) => {
      for (const [code, status] of [
        [3, 'failed'],
        [1, 'failed'],
        [undefined, 'failed'],
      ] as const) {
        const item = {
          id: tag,
          name: 'damaged-media',
          contentType: tag === 'audio' ? 'audio/mpeg' : 'video/mp4',
        };
        const resolveUrl = vi.fn().mockResolvedValue(signed());
        render({ items: [item], resolveUrl });
        await act(async () => controller.preview(item));
        const media = document.querySelector<HTMLMediaElement>(tag)!;
        act(() => media.dispatchEvent(new Event('loadeddata')));
        Object.defineProperty(media, 'error', {
          configurable: true,
          value: code === undefined ? null : { code },
        });
        const oldLoaded = controller.dialogProps.onMediaLoad!;
        const oldError = controller.dialogProps.onMediaError;
        await act(async () => media.dispatchEvent(new Event('error')));
        expect(controller.dialogProps.status).toBe(status);
        expect(resolveUrl).toHaveBeenCalledTimes(1);
        expect(document.querySelector(tag)).toBeNull();
        expect(button('Download')).toBeTruthy();
        act(() => oldLoaded());
        act(() => oldError(code));
        expect(resolveUrl).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(['audio', 'video'])(
    'renews an initial %s source error once before showing unsupported with download',
    async (tag) => {
      const item = {
        id: tag,
        name: 'expired-media',
        contentType: tag === 'audio' ? 'audio/mpeg' : 'video/mp4',
      };
      let signature = 0;
      const resolveUrl = vi.fn(async () =>
        signed('attachment', `https://media.test/${++signature}`),
      );
      render({ items: [item], resolveUrl });
      await act(async () => controller.preview(item));
      const staleError = controller.dialogProps.onMediaError;
      const sourceError = () => {
        const media = document.querySelector<HTMLMediaElement>(tag)!;
        Object.defineProperty(media, 'error', { configurable: true, value: { code: 4 } });
        media.dispatchEvent(new Event('error'));
      };
      await act(async () => sourceError());
      expect(resolveUrl).toHaveBeenCalledTimes(2);
      expect(controller.dialogProps.status).toBe('content');
      expect(document.querySelector(tag)?.getAttribute('src')).toBe('https://media.test/2');
      await act(async () => sourceError());
      expect(resolveUrl).toHaveBeenCalledTimes(2);
      expect(controller.dialogProps.status).toBe('unsupported');
      expect(document.querySelector(tag)).toBeNull();
      expect(button('Download')).toBeTruthy();
      expect(
        [...document.querySelectorAll('button')].some((button) => button.textContent === 'Retry'),
      ).toBe(false);
      act(() => staleError(4));
      expect(resolveUrl).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['image/png', 'img', 'load'],
    ['audio/mpeg', 'audio', 'loadeddata'],
    ['video/mp4', 'video', 'loadeddata'],
    ['video/quicktime', 'video', 'loadeddata'],
  ])(
    'renews %s through multiple expiry cycles after successful loads, but still bounds consecutive failures',
    async (contentType, tag, loadedEvent) => {
      const item = { id: 'long-media', name: 'lesson', contentType };
      let signature = 0;
      const resolveUrl = vi.fn(async () =>
        signed('attachment', `https://media.test/${++signature}`),
      );
      render({ items: [item], resolveUrl });
      await act(async () => controller.preview(item));
      const staleLoad = controller.dialogProps.onMediaLoad!;
      const mediaError = (code = 2) => {
        const media = document.querySelector(tag)!;
        if (tag !== 'img')
          Object.defineProperty(media, 'error', { configurable: true, value: { code } });
        media.dispatchEvent(new Event('error'));
      };
      await act(async () => mediaError(4));
      expect(resolveUrl).toHaveBeenCalledTimes(2);
      expect(document.querySelector(tag)?.getAttribute('src')).toBe('https://media.test/2');
      act(() => document.querySelector(tag)!.dispatchEvent(new Event(loadedEvent)));
      expect(controller.dialogProps.status).toBe('content');
      await act(async () => mediaError());
      expect(resolveUrl).toHaveBeenCalledTimes(3);
      act(() => staleLoad());
      await act(async () => mediaError());
      expect(resolveUrl).toHaveBeenCalledTimes(3);
      expect(controller.dialogProps.status).toBe('failed');
    },
  );

  it('shows download-only document fallback and accepts host Chinese labels', async () => {
    const resolveUrl = vi.fn().mockResolvedValue(signed('attachment'));
    render({ items, resolveUrl }, chineseLabels);
    await act(async () => {
      await controller.preview(items[1]!);
    });
    expect(controller.dialogProps.status).toBe('unsupported');
    expect(document.body.textContent).toContain('暂不支持预览');
    expect(document.querySelector('img')).toBeNull();
    expect(button('下载')).toBeTruthy();
    expect(document.querySelector('a[target="_blank"]')).toBeNull();
  });

  it.each([
    ['image/png', 'img'],
    ['audio/mpeg', 'audio'],
    ['video/mp4', 'video'],
  ])('renders %s subresources even with attachment disposition', async (contentType, tag) => {
    const item = { id: tag, name: 'media', contentType };
    render({
      items: [item],
      resolveUrl: vi.fn().mockResolvedValue({ ...signed('attachment'), contentType }),
    });
    await act(async () => {
      await controller.preview(item);
    });
    expect(controller.dialogProps.status).toBe('content');
    expect(document.querySelector(tag)?.getAttribute('src')).toBe('https://media.test/file');
    expect(document.querySelector('a[target="_blank"]')).toBeNull();
  });

  it('retains navigation focus at the last item and handles unsupported QuickTime codecs', async () => {
    render({ items, resolveUrl: vi.fn().mockResolvedValue(signed()) });
    await act(async () => {
      await controller.preview(items[0]!);
    });
    act(() => button('Next').focus());
    await act(async () => button('Next').click());
    await act(async () => button('Next').click());
    expect(document.activeElement).toBe(button('Previous'));
    await act(async () => key(document.activeElement!, 'ArrowLeft'));
    expect(controller.dialogProps.item?.id).toBe('two');
    const video = { id: 'mov', name: 'lesson.mov', contentType: 'video/quicktime' };
    render({ items: [video], resolveUrl: vi.fn().mockResolvedValue(signed('attachment')) });
    await act(async () => {
      await controller.preview(video);
    });
    await act(async () => document.querySelector('video')!.dispatchEvent(new Event('error')));
    expect(controller.dialogProps.status).toBe('unsupported');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('retries a signing failure and automatically resigns media at most once before showing failure', async () => {
    const error = new Error('Sign unavailable');
    const resolveUrl = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(signed('inline', 'https://media.test/first'))
      .mockResolvedValueOnce(signed('inline', 'https://media.test/second'))
      .mockResolvedValueOnce(signed('inline', 'https://media.test/third'));
    const onError = vi.fn();
    render({ items, resolveUrl, onError });
    await act(async () => {
      await controller.preview(items[0]!);
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    expect(onError).not.toHaveBeenCalled();
    await act(async () => button('Retry').click());
    expect(document.querySelector('img')?.src).toBe('https://media.test/first');
    await act(async () => document.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(document.querySelector('img')?.src).toBe('https://media.test/second');
    await act(async () => document.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(resolveUrl).toHaveBeenCalledTimes(3);
    expect(controller.dialogProps.status).toBe('failed');
    await act(async () => button('Retry').click());
    expect(document.querySelector('img')?.src).toBe('https://media.test/third');
  });

  it('ignores stale successes, errors and media events after navigation or closing', async () => {
    const old = deferred<AttachmentUrl>();
    const closed = deferred<AttachmentUrl>();
    const resolveUrl = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(signed('inline', 'https://media.test/current'))
      .mockReturnValueOnce(closed.promise);
    const onError = vi.fn();
    render({ items, resolveUrl, onError });
    act(() => {
      void controller.preview(items[0]!);
    });
    await act(async () => {
      await controller.preview(items[1]!);
    });
    await act(async () => old.resolve(signed('inline', 'https://media.test/stale')));
    expect(controller.dialogProps.item?.id).toBe('two');
    expect(controller.dialogProps.url).toBe('https://media.test/current');
    const oldMediaError = controller.dialogProps.onMediaError;
    act(() => {
      void controller.preview(items[0]!);
    });
    act(() => oldMediaError());
    expect(resolveUrl).toHaveBeenCalledTimes(3);
    act(() => controller.dialogProps.onOpenChange(false));
    await act(async () => closed.reject(new Error('Late failure')));
    expect(controller.dialogProps.open).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('requests attachment on every download and triggers a temporary same-page anchor with failure feedback', async () => {
    const pending = deferred<AttachmentUrl>();
    const error = new Error('Forbidden');
    const resolveUrl = vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(error);
    const onError = vi.fn();
    const anchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true);
      anchors.push(this);
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render({ items, resolveUrl, onError });
    act(() => {
      void controller.download(items[0]!);
    });
    expect(controller.busyId).toBe('one');
    await act(async () => pending.resolve(signed('attachment')));
    expect(resolveUrl).toHaveBeenCalledWith(items[0], 'attachment', expect.any(AbortSignal));
    expect(anchors[0]?.download).toBe('课件.png');
    expect(anchors[0]?.target).toBe('');
    expect(anchors[0]?.isConnected).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(controller.busyId).toBeNull();
    await act(async () => {
      await controller.download(items[0]!);
    });
    expect(onError).toHaveBeenCalledWith(error, items[0], 'download');
    expect(controller.busyId).toBeNull();
  });

  it('sandboxes text, refuses executable URLs and ignores pending requests after unmount', async () => {
    const textItem = { id: 'text', name: 'notes.html', contentType: 'text/html' };
    const pending = deferred<AttachmentUrl>();
    const resolveUrl = vi
      .fn()
      .mockResolvedValueOnce({ ...signed(), contentType: 'text/plain; charset=utf-8' })
      .mockResolvedValueOnce(signed('inline', 'javascript:alert(1)'))
      .mockReturnValueOnce(pending.promise);
    const onError = vi.fn();
    render({ items: [textItem], resolveUrl, onError });
    await act(async () => {
      await controller.preview(textItem);
    });
    expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
    expect(document.querySelector('iframe')?.title).toBe('notes.html');
    await act(async () => {
      await controller.preview(textItem);
    });
    expect(controller.dialogProps.status).toBe('failed');
    expect(onError).not.toHaveBeenCalled();
    act(() => {
      void controller.preview(textItem);
    });
    act(() => root.render(null));
    await act(async () => pending.reject(new Error('After unmount')));
    expect(onError).not.toHaveBeenCalled();
  });

  it('downloads different attachments concurrently and prevents duplicate requests for the same item', async () => {
    const first = deferred<AttachmentUrl>();
    const second = deferred<AttachmentUrl>();
    const resolveUrl = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render({ items, resolveUrl });
    act(() => {
      void controller.download(items[0]!);
      void controller.download(items[0]!);
      void controller.download(items[1]!);
    });
    expect(resolveUrl).toHaveBeenCalledTimes(2);
    expect(controller.busyIds).toEqual(['one', 'two']);
    await act(async () => second.resolve(signed('attachment')));
    expect(controller.busyId).toBe('one');
    await act(async () => first.resolve(signed('attachment')));
    expect(controller.busyIds).toEqual([]);
    expect(click).toHaveBeenCalledTimes(2);
  });
});
