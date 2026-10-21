// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dropzone, validateFiles, type UploadRejection } from './Dropzone';
import { FileList, type FileListItem } from './FileList';
import { ImageUpload } from './ImageUpload';
import { UploadChooser } from './UploadChooser';
import { useUploadQueue, type UploadContext, type UploadQueue } from './useUploadQueue';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function file(name: string, size: number, type: string) {
  const blob = new File(['x'], name, { type });
  Object.defineProperty(blob, 'size', { value: size });
  return blob;
}

function key(target: Element, value: string) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function dragEvent(type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { dropEffect: 'none', files, types: ['Files'] },
  });
  return event;
}

const png = () => file('cover.png', 1000, 'image/png');
const pdf = () => file('notes.pdf', 2000, 'application/pdf');
const huge = () => file('huge.png', 10 * 1024 * 1024, 'image/png');

describe('validateFiles', () => {
  it('checks type (extension, wildcard, exact MIME), size and count in order', () => {
    const { accepted, rejected } = validateFiles([png(), pdf(), huge(), png(), png()], {
      accept: 'image/*, .pdf',
      currentCount: 1,
      maxFiles: 3,
      maxSize: 5 * 1024 * 1024,
    });
    expect(accepted.map((item) => item.name)).toEqual(['cover.png', 'notes.pdf']);
    expect(rejected.map((item) => [item.file.name, item.reason])).toEqual([
      ['huge.png', 'size'],
      ['cover.png', 'count'],
      ['cover.png', 'count'],
    ]);
    expect(validateFiles([pdf()], { accept: 'image/png' }).rejected[0]?.reason).toBe('type');
    expect(validateFiles([png(), png()], { multiple: false }).accepted).toHaveLength(1);
    expect(validateFiles([], {}).accepted).toEqual([]);
  });
});

describe('Upload interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.querySelector('[data-rx-portal-root]')?.replaceChildren();
  });

  it('Dropzone opens the file dialog on click and Enter/Space, and validates before onFiles', () => {
    const onFiles = vi.fn();
    const onReject = vi.fn<(rejections: UploadRejection[]) => void>();
    act(() =>
      root.render(
        <Dropzone
          accept="image/*"
          description="PNG, max 5MB"
          maxSize={5 * 1024 * 1024}
          onFiles={onFiles}
          onReject={onReject}
          title="Drop files"
        />,
      ),
    );
    const zone = container.querySelector<HTMLElement>('.rx-dropzone')!;
    const input = zone.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});

    expect(zone.getAttribute('role')).toBe('button');
    expect(zone.tabIndex).toBe(0);
    expect(zone.getAttribute('aria-labelledby')).toBeTruthy();
    expect(input.accept).toBe('image/*');
    expect(input.multiple).toBe(true);

    act(() => zone.click());
    key(zone, 'Enter');
    key(zone, ' ');
    expect(click).toHaveBeenCalledTimes(3);

    Object.defineProperty(input, 'files', { configurable: true, value: [png(), pdf(), huge()] });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'cover.png' })]);
    expect(onReject.mock.calls[0]![0].map((item) => item.reason)).toEqual(['type', 'size']);
  });

  it('Dropzone shows the drag-over state and accepts dropped files', () => {
    const onFiles = vi.fn();
    act(() => root.render(<Dropzone onFiles={onFiles} title="Drop" tone="primary" />));
    const zone = container.querySelector<HTMLElement>('.rx-dropzone')!;
    expect(zone.dataset.tone).toBe('primary');

    act(() => {
      zone.dispatchEvent(dragEvent('dragenter'));
    });
    expect(zone.dataset.state).toBe('active');
    const over = dragEvent('dragover');
    act(() => {
      zone.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    act(() => {
      zone.dispatchEvent(dragEvent('dragleave'));
    });
    expect(zone.dataset.state).toBe('idle');

    act(() => {
      zone.dispatchEvent(dragEvent('dragenter'));
      zone.dispatchEvent(dragEvent('drop', [png(), pdf()]));
    });
    expect(zone.dataset.state).toBe('idle');
    expect(onFiles.mock.calls[0]![0]).toHaveLength(2);
  });

  it('Dropzone disabled ignores clicks, keys and drops', () => {
    const onFiles = vi.fn();
    act(() => root.render(<Dropzone disabled onFiles={onFiles} title="Drop" />));
    const zone = container.querySelector<HTMLElement>('.rx-dropzone')!;
    const input = zone.querySelector<HTMLInputElement>('input')!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    expect(zone.tabIndex).toBe(-1);
    expect(zone.getAttribute('aria-disabled')).toBe('true');
    act(() => zone.click());
    key(zone, 'Enter');
    act(() => {
      zone.dispatchEvent(dragEvent('drop', [png()]));
    });
    expect(click).not.toHaveBeenCalled();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('ImageUpload shows a dropzone when empty, preview/remove when filled, and a lightbox closed by Esc', () => {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    const render = (value: string | null, generating = false) =>
      act(() =>
        root.render(
          <ImageUpload
            alt="Course cover"
            closeLabel="Close"
            dropzoneTitle="Upload cover"
            generating={generating}
            generatingLabel="Generating cover…"
            headerAction={<button type="button">Generate</button>}
            heading="Cover"
            onChange={onChange}
            onRemove={onRemove}
            previewLabel="Preview"
            removeLabel="Remove"
            value={value}
          />,
        ),
      );

    render(null);
    const zone = container.querySelector<HTMLElement>('.rx-dropzone')!;
    expect(zone).toBeTruthy();
    expect(container.textContent).toContain('Generate');
    const input = zone.querySelector<HTMLInputElement>('input')!;
    expect(input.multiple).toBe(false);
    Object.defineProperty(input, 'files', { configurable: true, value: [png()] });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'cover.png' }));

    render('https://example.test/cover.png');
    expect(container.querySelector('.rx-dropzone')).toBeNull();
    expect(container.querySelector<HTMLImageElement>('img')?.alt).toBe('Course cover');
    const preview = container.querySelector<HTMLButtonElement>('[aria-label="Preview"]')!;
    act(() => preview.focus());
    act(() => preview.click());
    const dialog = document.querySelector<HTMLElement>('.rx-lightbox')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    key(document.activeElement!, 'Escape');
    expect(document.querySelector('.rx-lightbox')).toBeNull();
    expect(document.activeElement).toBe(preview);

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!.click());
    expect(onRemove).toHaveBeenCalledTimes(1);

    render('https://example.test/cover.png', true);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Generating cover…');
  });

  it('FileList renders counts, sizes and per-row states with move/remove/retry/cancel', () => {
    const onMove = vi.fn();
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const items: FileListItem[] = [
      {
        id: 'a',
        name: 'a-very-long-file-name-that-should-truncate.pdf',
        size: 2048,
        status: 'pending',
      },
      { id: 'b', name: 'b.png', progress: 40, size: 5 * 1024 * 1024, status: 'uploading' },
      { error: 'Network down', id: 'c', name: 'c.doc', size: 12, status: 'failed' },
    ];
    act(() =>
      root.render(
        <FileList
          cancelLabel="Cancel"
          failedLabel="Failed"
          footer="Up to 10 files"
          items={items}
          locale="en-US"
          max={10}
          moveDownLabel="Down"
          moveUpLabel="Up"
          onCancel={onCancel}
          onMove={onMove}
          onRemove={onRemove}
          onRetry={onRetry}
          pendingLabel="To be saved"
          removeLabel="Remove"
          retryLabel="Retry"
          selectLabel="Select files"
          titleLabel={(count, max) => `Attachments (${count}/${max})`}
        />,
      ),
    );
    expect(container.querySelector('.rx-file-list-title')?.textContent).toBe('Attachments (3/10)');
    const rows = [...container.querySelectorAll<HTMLElement>('.rx-file-list-row')];
    expect(rows.map((row) => row.dataset.state)).toEqual(['pending', 'uploading', 'failed']);
    expect(rows[0]!.querySelector('.rx-file-list-index')?.textContent).toBe('1.');
    expect(rows[0]!.querySelector('.rx-file-list-size')?.textContent).toBe('2 kB');
    expect(rows[1]!.querySelector('.rx-file-list-size')?.textContent).toBe('5 MB');
    expect(rows[0]!.querySelector('.rx-file-list-status')?.textContent).toBe('To be saved');
    expect(rows[1]!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '40',
    );
    expect(rows[2]!.querySelector('[role="alert"]')?.textContent).toBe('Network down');
    expect(container.querySelector('.rx-file-list-footer')?.textContent).toBe('Up to 10 files');

    const button = (row: Element, label: string) =>
      row.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    expect(button(rows[0]!, 'Up')?.disabled).toBe(true);
    expect(button(rows[2]!, 'Down')?.disabled).toBe(true);
    act(() => button(rows[0]!, 'Down')!.click());
    expect(onMove).toHaveBeenCalledWith('a', 'down');
    expect(button(rows[1]!, 'Remove')).toBeNull();
    act(() => button(rows[1]!, 'Cancel')!.click());
    expect(onCancel).toHaveBeenCalledWith('b');
    act(() => button(rows[2]!, 'Retry')!.click());
    expect(onRetry).toHaveBeenCalledWith('c');
    act(() => button(rows[0]!, 'Remove')!.click());
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  it('FileList selection button respects max and reports count rejections', () => {
    const onFiles = vi.fn();
    const onReject = vi.fn<(rejections: UploadRejection[]) => void>();
    const base = {
      cancelLabel: 'Cancel',
      failedLabel: 'Failed',
      formatSize: (bytes: number) => `${bytes} B`,
      moveDownLabel: 'Down',
      moveUpLabel: 'Up',
      onFiles,
      onReject,
      pendingLabel: 'Pending',
      removeLabel: 'Remove',
      retryLabel: 'Retry',
      selectLabel: 'Select files',
      titleLabel: (count: number, max: number | undefined) => `${count}/${max}`,
    };
    act(() =>
      root.render(
        <FileList {...base} items={[{ id: 'a', name: 'a', size: 1, status: 'done' }]} max={2} />,
      ),
    );
    expect(container.querySelector('.rx-file-list-size')?.textContent).toBe('1 B');
    expect(container.querySelector('.rx-file-list-status')).toBeNull();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [png(), pdf()] });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onFiles.mock.calls[0]![0]).toHaveLength(1);
    expect(onReject.mock.calls[0]![0].map((item) => item.reason)).toEqual(['count']);

    act(() =>
      root.render(
        <FileList
          {...base}
          items={[
            { id: 'a', name: 'a', size: 1, status: 'done' },
            { id: 'b', name: 'b', size: 1, status: 'done' },
          ]}
          max={2}
        />,
      ),
    );
    expect(
      container.querySelector<HTMLButtonElement>('.rx-file-list-header button')?.disabled,
    ).toBe(true);

    act(() => root.render(<FileList {...base} items={[]} />));
    expect(container.querySelector('.rx-file-list-items')).toBeNull();
    expect(container.querySelector('.rx-file-list-title')?.textContent).toBe('0/undefined');
  });

  it('UploadChooser renders both cards from props and reports the choice', () => {
    const onChoose = vi.fn();
    act(() =>
      root.render(
        <UploadChooser
          camera={{ actionLabel: 'Open camera', description: 'Take a photo', title: 'Camera' }}
          file={{ actionLabel: 'Choose file', description: 'PDF or image', title: 'File' }}
          onChoose={onChoose}
        />,
      ),
    );
    const cards = [...container.querySelectorAll<HTMLElement>('.rx-upload-chooser-card')];
    expect(cards.map((card) => card.dataset.kind)).toEqual(['camera', 'file']);
    const [camera, fileButton] = [...container.querySelectorAll<HTMLButtonElement>('button')];
    expect(camera!.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2);
    act(() => camera!.click());
    act(() => fileButton!.click());
    expect(onChoose.mock.calls).toEqual([['camera'], ['file']]);
  });
});

describe('useUploadQueue', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function setup() {
    const calls: {
      context: UploadContext;
      file: File;
      reject: (e: unknown) => void;
      resolve: (v: string) => void;
    }[] = [];
    const upload = vi.fn(
      (target: File, context: UploadContext) =>
        new Promise<string>((resolve, reject) => {
          calls.push({ context, file: target, reject, resolve });
        }),
    );
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const handle: { current: UploadQueue<string> | null } = { current: null };
    function Harness() {
      handle.current = useUploadQueue({ onError, onSuccess, upload });
      return null;
    }
    act(() => root.render(<Harness />));
    return { calls, handle, onError, onSuccess, upload };
  }

  const statuses = (queue: UploadQueue<string> | null) => queue!.items.map((item) => item.status);

  it('runs at most three uploads at once and starts the next when one settles', async () => {
    const { calls, handle, onSuccess } = setup();
    act(() => {
      handle.current!.add([png(), png(), png(), pdf(), pdf()]);
    });
    expect(calls).toHaveLength(3);
    expect(statuses(handle.current)).toEqual([
      'uploading',
      'uploading',
      'uploading',
      'queued',
      'queued',
    ]);

    act(() => calls[0]!.context.onProgress(55));
    expect(handle.current!.items[0]!.progress).toBe(55);
    act(() => calls[0]!.context.onProgress(250));
    expect(handle.current!.items[0]!.progress).toBe(100);

    await act(async () => {
      calls[0]!.resolve('url-1');
    });
    expect(handle.current!.items[0]).toMatchObject({ result: 'url-1', status: 'pending' });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(4);
    expect(statuses(handle.current)).toEqual([
      'pending',
      'uploading',
      'uploading',
      'uploading',
      'queued',
    ]);
  });

  it('cancels with the abort signal and retries failures', async () => {
    const { calls, handle, onError } = setup();
    let ids: string[] = [];
    act(() => {
      ids = handle.current!.add([png(), pdf()]);
    });
    act(() => handle.current!.cancel(ids[0]!));
    expect(calls[0]!.context.signal.aborted).toBe(true);
    expect(handle.current!.items.map((item) => item.id)).toEqual([ids[1]]);

    await act(async () => {
      calls[1]!.reject(new Error('boom'));
    });
    expect(handle.current!.items[0]).toMatchObject({ status: 'failed' });
    expect(onError).toHaveBeenCalledTimes(1);

    act(() => handle.current!.retry(ids[1]!));
    expect(calls).toHaveLength(3);
    expect(statuses(handle.current)).toEqual(['uploading']);
    await act(async () => {
      calls[2]!.resolve('ok');
    });
    expect(statuses(handle.current)).toEqual(['pending']);
  });

  it('ignores results of aborted uploads, moves items and aborts everything on unmount', async () => {
    const { calls, handle } = setup();
    let ids: string[] = [];
    act(() => {
      ids = handle.current!.add([png(), pdf()]);
    });
    act(() => handle.current!.move(ids[1]!, 'up'));
    expect(handle.current!.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
    act(() => handle.current!.remove(ids[0]!));
    await act(async () => {
      calls[0]!.resolve('late');
    });
    expect(handle.current!.items.map((item) => item.id)).toEqual([ids[1]]);
    act(() => root.unmount());
    expect(calls[1]!.context.signal.aborted).toBe(true);
    root = createRoot(container);
  });
});
